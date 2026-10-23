// Meta Lead Ads -> WhatsApp (Murpati) relay for Nusatravel.
// GET  /api/lead  -> Meta webhook verification
// POST /api/lead  -> leadgen notification; fetch lead data, send WhatsApp
export const config = { runtime: "nodejs" };

const GRAPH = "https://graph.facebook.com/v21.0";

async function getLead(leadId, token) {
  const r = await fetch(`${GRAPH}/${leadId}?access_token=${encodeURIComponent(token)}`);
  const j = await r.json();
  if (j.error) throw new Error(`Graph: ${j.error.message}`);
  const f = {};
  for (const d of j.field_data || []) f[d.name] = (d.values || [])[0] || "";
  return f;
}

async function sendWhatsApp({ apiKey, sessionId, to, message }) {
  const r = await fetch("https://api.murpati.com/v1/messages/send", {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      // ponytail: Murpati's WAF 403s the default undici UA. Upgrade path: drop
      // the header once their edge stops filtering server-side clients.
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ session_id: sessionId, to, message }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

// Meta sends "60123456789" or "+60 12-345 6789"; Murpati wants digits with country code.
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("60")) return d;
  if (d.startsWith("0")) return "60" + d.slice(1);
  // ponytail: 8-11 digit numbers without prefix are assumed Malaysian local.
  // Add a country field to the form if non-MY leads ever come in.
  if (d.length >= 8 && d.length <= 11) return "60" + d;
  return d;
}

// Package names arrive as form slugs ("PAKEJ YUNNAN", "wilayah_yunnan_") but read
// badly in a greeting. Prefer the folder's filename for display — it's already
// human-written ("YUNNAN.pdf") — and fall back to cleaning the raw value.
function prettyName(raw, file) {
  if (file) return file.replace(/\.pdf$/i, "").replace(/\b\w/g, (c) => c.toUpperCase());
  return String(raw || "")
    .replace(/_/g, " ")
    .replace(/\b(pakej|package|wilayah)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Pakej Ini";
}

function buildMessage(name, packageLabel) {
  // No PDF matched (or no package named) — don't promise an attachment that
  // isn't there; ask which package instead.
  if (!packageLabel) {
    return (
      `Assalamualaikum dan salam sejahtera.\n` +
      `Saya Zaqwan dari Nusatravel.\n` +
      `Terima kasih kerana berminat dengan pakej kami.\n` +
      `Boleh beritahu pakej mana yang tuan/puan minati? Saya akan hantar itinerary penuh. 😊`
    );
  }
  return (
    `Assalamualaikum dan salam sejahtera.\n` +
    `Saya Zaqwan dari Nusatravel.\n\n` +
    `Terima kasih kerana berminat dengan pakej ${packageLabel} kami.\n\n` +
    `Saya sertakan itinerary penuh pakej ini di bawah untuk rujukan tuan/puan. 😊`
  );
}

// Package folder on Drive. Filenames are the package names, so we match on the
// filename rather than trusting the sheet's stored links (those point at other
// file ids and go stale whenever a PDF is re-uploaded).
// ponytail: listed per request; folder has ~10 files. Upgrade path: cache the
// listing for 5 min if lead volume grows.
const DRIVE_FOLDER = process.env.PACKAGE_DRIVE_FOLDER || "1qmphDj3HqrxZrIJN2o_Gj88fVYN8r4Yt";

const ALIAS = {
  wilayahyunnan: ["yunnan"],
  china4wilayah: ["china4wilayah"],
  sichuanchengdu: ["sichuanchengdu", "chengdu"],
  xianlanzhou: ["xianlanzhou"],
  newzealand: ["newzealand"],
  xinjiang: ["xinjiang"],
  shanghaidisneyland: ["shanghaidisneyland"],
};

// Package names in the lead forms are snake_case ids ("wilayah_yunnan_"), filenames
// are prose ("YUNNAN.pdf"). Strip filler words AND standalone numbers — "THAILAND 5
// WILAYAH" vs "SCANDINAVIA 5 NEGARA" share only the digits, which is not a match.
const FILLER = new Set(["wilayah", "pakej", "package", "trip", "tour", "winter", "pdf"]);

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !FILLER.has(t) && !/^\d+$/.test(t));
}

async function listFolder() {
  const r = await fetch(`https://drive.google.com/embeddedfolderview?id=${DRIVE_FOLDER}#list`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) return [];
  const html = await r.text();
  // Drive emits one <div class="flip-entry" id="entry-<fileid>"> per file, each
  // containing exactly one flip-entry-title. Split on the entry marker first so
  // a title can never be paired with a neighbouring entry's id.
  const out = [];
  for (const chunk of html.split('class="flip-entry"').slice(1)) {
    const id = chunk.match(/id="entry-([A-Za-z0-9_-]{10,})"/);
    const name = chunk.match(/flip-entry-title">([^<]*)</);
    if (id && name) out.push({ id: id[1], name: htmlDecode(name[1]) });
  }
  return out;
}

function htmlDecode(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// A package can have several itineraries (one per airline/season), so return
// every file that plausibly belongs to it. An exact slug match wins outright;
// otherwise take files sharing at least half the package's words — the cutoff
// keeps "PAKEJ SICHUAN CHENGDU" from dragging in CHINA 4 WILAYAH, which shares
// only the generic word "china".
function getPackagePdfs(files, pkg) {
  const key = slug(pkg);
  const want = tokens(pkg);
  if (!key || !want.length) return [];

  const exact = files.filter((f) => slug(f.name.replace(/\.pdf$/i, "")) === key);
  if (exact.length) return exact;

  const need = Math.max(1, Math.ceil(want.length / 2));
  const hits = files.filter((f) => {
    const have = tokens(f.name.replace(/\.pdf$/i, ""));
    return want.filter((t) => have.includes(t)).length >= need;
  });
  // Fewest extra words first, so the closest-named itinerary reads first.
  return hits.sort((a, b) => tokens(a.name).length - tokens(b.name).length);
}

// Cap the batch so the text + N attachments stay inside Vercel's 4.5 MB body
// limit; a single oversized file is skipped rather than failing the whole send.
async function getPackagePdfsById(pkg) {
  return getPackagePdfs(await listFolder(), pkg);
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// Google Drive serves every download as `application/octet-stream`, so Murpati
// can't tell a PDF from a binary blob and WhatsApp renders it as "FILE BIN".
// Fetch the bytes ourselves and post them as base64 with an explicit type.
const MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

function mimeFor(name) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  return MIME[ext] || "application/octet-stream";
}

async function sendMedia({ apiKey, sessionId, to, mediaUrl, caption, filename }) {
  const r = await fetch("https://api.murpati.com/v1/messages/send-media", {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({
      session_id: sessionId,
      to,
      media_base64: mediaUrl,
      media_type: "document",
      caption,
      filename,
      mime_type: mimeFor(filename),
    }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

// ponytail: one endpoint, two producers (Meta native webhook + Make.com HTTP module).
// Make sends flat JSON; Meta sends entry[].changes[]. Upgrade path: split into
// /api/lead/meta and /api/lead/make if either shape grows real logic.
function pick(o, ...keys) {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// Form answers can arrive nested (additional_answers) with slugged keys, so scan
// one level deep for any key matching the pattern before giving up. The nested
// scope is checked FIRST — that's where the customer's real dropdown answer
// lives, while top-level pakej/package are often mapped to the form label.
function pickByKey(o, re) {
  for (const scope of [o?.additional_answers, o]) {
    if (!scope || typeof scope !== "object") continue;
    for (const [k, v] of Object.entries(scope)) {
      if (!re.test(k)) continue;
      // Ignore keys that merely mention the package in passing ("pakej_quantity").
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

function flatToLead(b) {
  const fields = b.fields && typeof b.fields === "object" ? b.fields : {};
  const merged = { ...fields, ...b };
  const phone = pick(merged, "phone_number", "phone", "mobile", "whatsapp", "no_tel", "nombor");
  if (!phone) return null;
  return {
    name: pick(merged, "full_name", "name", "nama", "first_name") || "Customer",
    phone,
    // The real package answer lives in the form's dropdown, which Make nests
    // under additional_answers with a slug key ("sila_pilih_senarai_pakej_").
    // That answer BEATS the top-level pakej/package fields: the scenario maps
    // those to the Meta form label ("UPDATE SEAT DEC 2026"), which is a campaign
    // name, not the package the customer picked.
    source:
      pickByKey(merged, /pakej|package/i) ||
      pick(merged, "pakej", "package", "pakej_name") ||
      "",
  };
}

// Look the PDFs up first so the greeting can name the package the way the files
// do, then send text + one attachment per matched itinerary.
async function deliver({ apiKey, sessionId, to, name, source }) {
  const files = await getPackagePdfsById(source).catch(() => []);
  const label = files.length ? prettyName(source, files[0].name) : "";
  const text = await sendWhatsApp({ apiKey, sessionId, to, message: buildMessage(name, label) });

  const pdfs = [];
  for (const f of files) {
    // Each attachment is its own request to Murpati, so the limit applies per
    // file, not to the batch. Vercel's 4.5 MB cap is on our *inbound* body; the
    // only ceiling here is base64 (4/3) plus Murpati's own upload size.
    const blob = await fetchPdf(`https://drive.usercontent.google.com/download?id=${f.id}&export=download`);
    if (!blob) {
      pdfs.push({ name: f.name, ok: false, error: "too large or download failed" });
      continue;
    }
    const r = await sendMedia({
      apiKey,
      sessionId,
      to,
      mediaUrl: blob,
      caption: `ITINERARY ${prettyName(source, f.name).toUpperCase()}`,
      filename: f.name,
    });
    pdfs.push({ name: f.name, ok: r.ok, status: r.status, body: r.body });
    // Murpati rate-limits rapid bursts, and the first file in a batch was the
    // one that failed — space the sends out.
    if (files.length > 1) await new Promise((res) => setTimeout(res, 1500));
  }

  return { text, pdfs, package: source, pdfNames: files.map((f) => f.name) };
}

// Fetch the Drive file and hand Murpati base64. Outbound body is Murpati's
// limit, not Vercel's, so the per-file ceiling is generous — base64 inflates
// raw bytes by 4/3.
async function fetchPdf(url, budget = 8_000_000) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > budget) return null;
  return buf.toString("base64");
}

export default async function handler(req, res) {
  // Vercel's request logs aren't readable via API, so mirror every inbound hit
  // to stdout — it shows up in the dashboard's Runtime Logs.
  const body = typeof req.body === "string" ? safeJson(req.body) : req.body || {};
  console.log(
    "INBOUND",
    JSON.stringify({
      method: req.method,
      ua: String(req.headers["user-agent"] || "").slice(0, 40),
      ref: String(req.headers.referer || "").slice(0, 60),
      keys: Object.keys(body),
      entry: Array.isArray(body.entry) ? body.entry.length : 0,
      name: body.full_name || body.name || body.first_name || "",
      phone: body.phone_number || body.phone || "",
      pakej: body.pakej || body.form || body.form_name || body.package || "",
      // Temporary: dump the nested answers verbatim so a lead that arrives with
      // an empty package name shows exactly which key the answer lives under.
      answers: body.additional_answers || body.fields || null,
      raw: JSON.stringify(body).slice(0, 900),
    })
  );
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const META_TOKEN = process.env.META_ADS_ACCESS_TOKEN;
  const API_KEY = process.env.MURPATI_API_KEY;
  const SESSION_ID = process.env.MURPATI_SESSION_ID;

  if (req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === VERIFY_TOKEN) {
      return res.status(200).send(q.get("hub.challenge") || "");
    }
    return res.status(403).send("forbidden");
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  // Await the work so Vercel doesn't freeze the function early (no waitUntil needed).
  const out = { sent: [], skipped: [] };
  try {
    const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});

    // Producer 1: Meta native webhook (entry[].changes[] with leadgen_id).
    if (Array.isArray(body.entry) && body.entry.length) {
      for (const entry of body.entry) {
        for (const change of entry.changes || []) {
          if (change.field !== "leadgen") continue;
          const leadId = change.value?.leadgen_id;
          if (!leadId) continue;
          try {
            const fields = await getLead(leadId, META_TOKEN);
            const to = normalizePhone(fields.phone_number || fields.phone || fields.mobile);
            if (!to) {
              out.skipped.push({ leadId, reason: "no phone" });
              continue;
            }
            const name = fields.full_name || fields.first_name || "Customer";
            const r = await deliver({ apiKey: API_KEY, sessionId: SESSION_ID, to, name, source: fields.form_name || "Turkiye Classic" });
            out.sent.push({ leadId, to, ...r });
          } catch (e) {
            out.skipped.push({ leadId, reason: String(e.message || e) });
          }
        }
      }
      return res.status(200).json(out);
    }

    // Producer 2: Make.com flat payload.
    const lead = flatToLead(body);
    if (!lead) {
      out.skipped.push({ reason: "no phone in payload", keys: Object.keys(body).slice(0, 20) });
      return res.status(200).json(out);
    }
    const to = normalizePhone(lead.phone);
    if (!to) {
      out.skipped.push({ reason: "unparseable phone", raw: lead.phone });
      return res.status(200).json(out);
    }
    const r = await deliver({ apiKey: API_KEY, sessionId: SESSION_ID, to, name: lead.name, source: lead.source });
    out.sent.push({ source: "make", to, name: lead.name, ...r });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  return res.status(200).json(out);
}

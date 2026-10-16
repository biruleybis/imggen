const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { Resend } = require("resend");
const sharp = require("sharp");

// ── MongoDB driver ────────────────────────────────────────────────────────────
const { MongoClient } = require("mongodb");
const MONGO_URI = process.env.MONGODB_URI;
let db = null;

async function connectMongo() {
  if (!MONGO_URI) {
    console.warn("MONGODB_URI not set — using local filesystem only");
    return;
  }
  try {
    const uri = MONGO_URI.startsWith("mongodb+srv") ? MONGO_URI : MONGO_URI;
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      tls: MONGO_URI.startsWith("mongodb+srv"),
    });
    await client.connect();
    db = client.db("imggen");
    await db.collection("templates").createIndex({ slug: 1 }, { unique: true });
    console.log("MongoDB connected ✓");
  } catch (e) {
    console.error("MongoDB connection failed:", e.message);
    db = null;
  }
}

// ── Config helpers (MongoDB + filesystem fallback) ────────────────────────────
async function readConfigAsync(slug) {
  if (db) {
    const doc = await db.collection("templates").findOne({ slug });
    if (doc) { delete doc._id; return doc; }
    return null;
  }
  const p = configPath(slug);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return null;
}

async function writeConfigAsync(slug, data) {
  if (db) {
    await db.collection("templates").updateOne(
      { slug },
      { $set: { ...data, slug } },
      { upsert: true }
    );
  }
  writeConfig(slug, data);
}

async function listTemplatesAsync() {
  if (db) {
    const docs = await db.collection("templates").find({}, { projection: { slug: 1, label: 1 } }).toArray();
    return docs.map(d => ({ slug: d.slug, label: d.label || d.slug }));
  }
  // fallback: filesystem
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  const slugs = fs.readdirSync(TEMPLATES_DIR).filter(d =>
    fs.statSync(path.join(TEMPLATES_DIR, d)).isDirectory() && fs.existsSync(configPath(d))
  );
  return slugs.map(slug => {
    const cfg = readConfig(slug);
    return { slug, label: cfg?.label || slug };
  });
}

async function deleteTemplateAsync(slug) {
  if (db) {
    await db.collection("templates").deleteOne({ slug });
  }
  const dir = templateDir(slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── Auth config ───────────────────────────────────────────────────────────────
const AUTH_PASSWORD   = process.env.AUTH_PASSWORD || "samara2024";
const AUTH_EMAIL_TO   = process.env.AUTH_EMAIL    || "mentorbrunoribas@gmail.com";
const AUTH_EMAIL_FROM = "ImgReview <noreply@ribasic.com.br>";
const resend = new Resend(process.env.RESEND_API_KEY);

// Session store (ephemeral — restarts invalidate sessions, user just logs in again)
const sessionStore = new Map(); // sessionId → expires

const OTP_SECRET = process.env.OTP_SECRET || "imgr-secret-2024";

function genToken() { return crypto.randomBytes(16).toString("hex"); }
function genOtp()   { return String(Math.floor(100000 + Math.random() * 900000)); }

// Encode OTP into a signed token so it survives server restarts (no memory needed)
function encodeOtpToken(otp) {
  const expires = Date.now() + 30 * 60 * 1000;
  const payload = `${otp}:${expires}`;
  const sig = crypto.createHmac("sha256", OTP_SECRET).update(payload).digest("hex").slice(0, 16);
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}
function decodeOtpToken(token) {
  try {
    const raw = Buffer.from(token, "base64url").toString();
    const parts = raw.split(":");
    if (parts.length !== 3) return null;
    const [otp, expires, sig] = parts;
    const payload = `${otp}:${expires}`;
    const expected = crypto.createHmac("sha256", OTP_SECRET).update(payload).digest("hex").slice(0, 16);
    if (sig !== expected) return null;
    if (Date.now() > Number(expires)) return null;
    return otp;
  } catch { return null; }
}

function isAuthed(req) {
  const sid = req.headers["x-session-id"] || req.query._sid;
  if (!sid) return false;
  const exp = sessionStore.get(sid);
  return exp && Date.now() < exp;
}

const app = express();
const PORT = process.env.PORT || 3000;
const TEMPLATES_DIR = path.join(__dirname, "templates");

// ── Register Google Fonts (woff2 supported by @napi-rs/canvas) ───────────────
(function registerFonts() {
  const fontsourceDir = path.join(__dirname, "node_modules/@fontsource");
  const toRegister = [
    { pkg: "great-vibes",       file: "great-vibes-latin-400-normal.woff2",             family: "Great Vibes" },
    { pkg: "dancing-script",    file: "dancing-script-latin-700-normal.woff2",           family: "Dancing Script" },
    { pkg: "sacramento",        file: "sacramento-latin-400-normal.woff2",               family: "Sacramento" },
    { pkg: "satisfy",           file: "satisfy-latin-400-normal.woff2",                  family: "Satisfy" },
    { pkg: "playfair-display",  file: "playfair-display-latin-700-normal.woff2",         family: "Playfair Display" },
    { pkg: "playfair-display",  file: "playfair-display-latin-700-italic.woff2",         family: "Playfair Display" },
    { pkg: "cormorant-garamond",file: "cormorant-garamond-latin-700-italic.woff2",       family: "Cormorant Garamond" },
    { pkg: "cinzel",            file: "cinzel-latin-700-normal.woff2",                   family: "Cinzel" },
    { pkg: "pacifico",          file: "pacifico-latin-400-normal.woff2",                 family: "Pacifico" },
    { pkg: "josefin-sans",      file: "josefin-sans-latin-700-normal.woff2",             family: "Josefin Sans" },
    { pkg: "bebas-neue",        file: "bebas-neue-latin-400-normal.woff2",               family: "Bebas Neue" },
    { pkg: "oswald",            file: "oswald-latin-700-normal.woff2",                   family: "Oswald" },
    { pkg: "yeseva-one",        file: "yeseva-one-latin-400-normal.woff2",               family: "Yeseva One" },
    { pkg: "vollkorn",          file: "vollkorn-latin-700-normal.woff2",                 family: "Vollkorn" },
    { pkg: "abhaya-libre",      file: "abhaya-libre-latin-700-normal.woff2",             family: "Abhaya Libre" },
    { pkg: "oranienbaum",       file: "oranienbaum-latin-400-normal.woff2",              family: "Oranienbaum" },
  ];
  for (const { pkg, file, family } of toRegister) {
    const fontPath = path.join(fontsourceDir, pkg, "files", file);
    if (fs.existsSync(fontPath)) {
      try {
        GlobalFonts.register(fs.readFileSync(fontPath), family);
      } catch (e) {
        console.warn(`Font register failed: ${family} — ${e.message}`);
      }
    } else {
      console.warn(`Font file not found: ${fontPath}`);
    }
  }
  console.log(`Fonts registered. Families available: ${GlobalFonts.families.length}`);
})();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
}));

const renderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many requests, please slow down." },
});

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));

// ── Auth routes (public — before static/auth guard) ───────────────────────────

app.post("/auth/step1", rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
  const { password } = req.body || {};
  if (password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta" });
  }
  const otp   = genOtp();
  const token = encodeOtpToken(otp);

  try {
    await resend.emails.send({
      from: AUTH_EMAIL_FROM,
      to:   AUTH_EMAIL_TO,
      subject: `ImgReview — código de acesso: ${otp}`,
      html: `<p>Seu código de verificação é: <strong style="font-size:24px;letter-spacing:4px">${otp}</strong></p><p>Válido por 30 minutos.</p>`,
    });
  } catch (e) {
    console.error("Resend error:", e.message);
    return res.status(500).json({ error: "Erro ao enviar email" });
  }

  res.json({ token });
});

app.post("/auth/step2", rateLimit({ windowMs: 60000, max: 20 }), (req, res) => {
  const { token, otp } = req.body || {};
  const received = String(otp || "").replace(/\s+/g, "").trim();
  const storedOtp = decodeOtpToken(token);
  console.log(`OTP check: stored=${storedOtp} received=${received}`);
  if (!storedOtp) {
    return res.status(401).json({ error: "Código expirado — clique em Voltar e tente novamente" });
  }
  if (storedOtp !== received) {
    return res.status(401).json({ error: "Código incorreto" });
  }
  const sid = genToken();
  sessionStore.set(sid, Date.now() + 8 * 60 * 60 * 1000); // 8 hours
  res.json({ sessionId: sid });
});

app.get("/auth/check", (req, res) => {
  res.json({ ok: isAuthed(req) });
});

app.post("/auth/logout", (req, res) => {
  const sid = req.headers["x-session-id"];
  if (sid) sessionStore.delete(sid);
  res.json({ ok: true });
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// ── Auth guard middleware ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

function authGuard(req, res, next) {
  if (!isAuthed(req)) {
    return res.status(401).json({ error: "Não autenticado" });
  }
  next();
}
app.use("/api", authGuard);
app.use("/template-image", authGuard);
app.use("/template-icon", authGuard);

// ── Storage: templates & icons ─────────────────────────────────────────────────
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(TEMPLATES_DIR, req.params.slug || "tmp");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = file.fieldname === "icon" ? "icon" : "photo";
    cb(null, base + ext);
  },
});

const allowedMime = ["image/jpeg", "image/png", "image/webp", "image/svg+xml"];
const upload = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (allowedMime.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG, WebP and SVG files are allowed."));
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function templateDir(slug) {
  return path.join(TEMPLATES_DIR, slug);
}

function configPath(slug) {
  return path.join(templateDir(slug), "config.json");
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function readConfig(slug) {
  const p = configPath(slug);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeConfig(slug, data) {
  const dir = templateDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(slug), JSON.stringify(data, null, 2));
}

function findPhoto(slug) {
  for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
    const p = path.join(templateDir(slug), "photo" + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findIcon(slug) {
  for (const ext of [".png", ".svg", ".jpg", ".webp"]) {
    const p = path.join(templateDir(slug), "icon" + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── GET /api/templates ──────────────────────────────────────────────────────────
app.get("/api/templates", async (req, res) => {
  try {
    const list = await listTemplatesAsync();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/templates/:slug ───────────────────────────────────────────────────
app.get("/api/templates/:slug", async (req, res) => {
  try {
    const cfg = await readConfigAsync(req.params.slug);
    if (!cfg) return res.status(404).json({ error: "Template not found" });
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/templates/:slug/photo ───────────────────────────────────────────
app.post("/api/templates/:slug/photo", upload.single("photo"), async (req, res) => {
  const { slug } = req.params;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const rawBuffer = fs.readFileSync(req.file.path);
  // Convert to JPEG regardless of input format (handles HEIC, WebP, PNG, etc.)
  let fileBuffer, mime;
  try {
    fileBuffer = await sharp(rawBuffer).jpeg({ quality: 92 }).toBuffer();
    mime = "image/jpeg";
  } catch (convErr) {
    console.warn("sharp conversion failed, using raw:", convErr.message);
    fileBuffer = rawBuffer;
    mime = req.file.mimetype || "image/jpeg";
  }
  const photoBase64 = `data:${mime};base64,${fileBuffer.toString("base64")}`;

  try {
    let cfg = await readConfigAsync(slug);
    if (!cfg) cfg = { slug, label: slug, icon: null };
    cfg.photo_data = photoBase64;
    await writeConfigAsync(slug, cfg);
    res.json({ ok: true, file: req.file.filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/templates/:slug/icon ────────────────────────────────────────────
app.post("/api/templates/:slug/icon", upload.single("icon"), (req, res) => {
  const { slug } = req.params;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ ok: true, file: req.file.filename });
});

// ── DELETE /api/templates/:slug/icon ─────────────────────────────────────────
app.delete("/api/templates/:slug/icon", async (req, res) => {
  const { slug } = req.params;
  for (const ext of [".png", ".svg", ".jpg", ".webp"]) {
    const p = path.join(templateDir(slug), "icon" + ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  try {
    const cfg = await readConfigAsync(slug);
    if (cfg) { cfg.icon = null; await writeConfigAsync(slug, cfg); }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/templates/:slug ──────────────────────────────────────────────────
app.put("/api/templates/:slug", async (req, res) => {
  const { slug } = req.params;
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid body" });
  try {
    await writeConfigAsync(slug, { ...body, slug });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/templates (create new) ──────────────────────────────────────────
app.post("/api/templates", async (req, res) => {
  const { label } = req.body || {};
  if (!label) return res.status(400).json({ error: "label is required" });
  const slug = slugify(label) || Date.now().toString();
  try {
    const existing = await readConfigAsync(slug);
    if (existing) return res.status(409).json({ error: "Template already exists", slug });
    const newCfg = {
      slug,
      label,
      box: { x: 50, y: 50, width: 300, height: 80, radius: 12, border_width: 0, border_color: "#ffffff" },
      text: { font_size: 40, font_color: "#2563EB", bg_color: "#ffffff", bold: true, align: "center", opacity: 1 },
      icon: null,
    };
    await writeConfigAsync(slug, newCfg);
    res.status(201).json({ slug, label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/templates/:slug ───────────────────────────────────────────────
app.delete("/api/templates/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    await deleteTemplateAsync(slug);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /template-image/:slug ─────────────────────────────────────────────────
app.get("/template-image/:slug", async (req, res) => {
  try {
    const cfg = await readConfigAsync(req.params.slug);
    if (cfg && cfg.photo_data) {
      const matches = cfg.photo_data.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const mime = matches[1];
        const buf = Buffer.from(matches[2], "base64");
        res.set("Content-Type", mime);
        return res.send(buf);
      }
    }
    const p = findPhoto(req.params.slug);
    if (!p) return res.status(404).send("No photo");
    res.sendFile(p);
  } catch (e) {
    res.status(500).send("Error");
  }
});

// ── GET /template-icon/:slug ──────────────────────────────────────────────────
app.get("/template-icon/:slug", (req, res) => {
  const p = findIcon(req.params.slug);
  if (!p) return res.status(404).send("No icon");
  res.sendFile(p);
});

// ── PNG assets embutidos (Google G + Estrela) ─────────────────────────────────
const PNG_GOOGLE_B64 = "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";
const PNG_STAR_B64 = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAaMSURBVHic7ZxbjBRFFIa/MzsLq6Cr4ApCRIHdYXpFTYwQiLdoogZFosZrjHiJqHiLMfgkvumTGF/0xWuCmmhMNFGiiTH6QnjwTaLMDKt4QSKwImBgXZeZOT7QkJXdxb5UV3VjfclmO52uOn+f06eq+nT3gMfj8Xg8Ho/H4/EUCG2wSBsscq0jDWXXAlLR5pFw6z7HShIjrgUkRQc4lSa7AShzpvTxp2tNSSi5FpCYJg8Ck4HJNFnlWk5SCpkBqgg1fkKYc3gHvxBwrgjqWltcipkBDa496nwAYQ4NrnWqKSHFDIDy6Dj7Hhn32JxTuCFIf2AOI/w0jvY2k5gr8/nFkbREFC8DRlg9wYVTYoSHHShKRaEyQJUydXYC0yc4ZA9VZorQtCwtMcXKgAZ3HMf5ANNpcLtFRakpVgDGm3zHHlOoybgwQ5AOcB5Nvo10cJmF0sd3mYsyQHEyoMWTkY9t8kSmWgxSiAwYVfeZHK0BQ3RyVhHqQ8XIgBb3R3Y+gHAyLe7NVJMhihGAdoTJd2ybxzPRYpjcB0C3cDVCb+yGQq/WuSoTUQbJfQAgxbKyAEvSXE/C+iMzGWZHigulTRezZS47DUszRr4z4C8eS6mxxDCrDSoyTm4zIELdJyo7qXJ2XutD+c2AGrcYcD7ATBrcZKCfTMhvAEiw9JyIHE/GuRyCYtV9otJJn/TyvdE+DeA8ALqFsyjRg9BDK/wPN4LxNfwXwMcog3QwiDJIm0Hp5zfDdmJhNACqTOIHZjASOlLooT1m+wygB6UH4bQcXASKsg9hEMLAHNkeva8cbveyW4QRU8Yjn7zWuAZh9lHnETpVmQbMDB06xZSwnHMA+B34DWEvOiZgOyTg8ygdRX81sYP9NHkP4fSj+0a/heP6OrbL1PDv3H/5QAFlL2WWRe0oltt0K/No8RlQiSX3/8NWOlgmFbZFbRBrGSoVtjGJxcBXieSd2HzFJBbHcT5JBw5VOqjzJrAySfsTkNeoslqEVtyGiW7ERGhJwD3AGqCdpI8ThDawRgIeTOJ8TEydWmM5yvsIJ6ftq1AoQwi3S8CGNN0YWbtonQtQPgVmm+ivAOxAuE6qbE7bkbHFo25jBn/zOXCBqT5zymYmc43MY5eJzowV42Qeu+hmKaRLyZyzgW6WmnI+pquhMoshqqwA1pnsNxcoL1BlhcxiyGS3md2/6hZWIrwJdGRlwwrKIeAB6Wd9Ft1nWkDQOleifAR0Z2knQ/ZTYrksYGNWBjKv4GiNCvAZMC9rW4bZBiyTgK1ZGrFSQtOfOZ2DfIxwqQ17qVE2MoUVcg57szZlrYapSid11gN32LKZkPeoslKEQzaMWXsmLMIhCbgTYe0xhey8oMAzEnCnLefjqoqvNW4G3gW6XNgfh2HgLgn40LZhZ49RtMZy4BNX9v9FietlAZ+6Me2Kw8+D84GOespnGXcBUC5zZvtYHGrxAcCtFjeT8HamcYA9LmxPyFSmy9n8YdusmwwY4nIndo/HQTdZ4CYA7RwNP0dwNAy5mgPylwGONFmfA/RHuhjmYA7fzG7TxRSZy7BNo/ad8BeX5dD5ACUO2S8W2ndEKYfj/xFa9rXZD0Ce1v9jObEDoEoZWGLTZkyWhhqtYTcD6iwyVgFVtgM3ADeE2yboCjVaw24A1MhS72+E5ziJigRskIANnEQF5Xkw8OGE2B2G7AYg/cl9SZnzpMqzo5eLMpdh6WctZfqBL1NZsDxH2XwkWaLO/vDDhrj8ivCUVPkgkq06t6K8lPBVyQMScEqCdomwlwENFsZ2vtIE1tHNgqjOB5AqH9BNBXgx7CMOU7XG+THbJMZeAOLXfzZRYqEEPJ3kbTSZxZAErKGTC4FNsRpbvFexF4CoJ6XsQrhbAi6RKo20ZqWPLRJwCSVWQvhr6/+FxWKhvQD89wqoBbxMJxWp8o5p87KAtynTB7wS4aOSK0zbnwg7L2YNMJ/mcb5SV76mxCoT79tH0nP4e4a3gIsmPKiD+XG/90qCnQxoTpjSe1BWEbDElvM5PElvpsrFwEMwwVMwS3UhOwEYu7ZW4DW66JV+Xnfxu/8iqAS8ClQQ3hjzspjlG7JM0RpbtYaGf99og8WuNR2LNlisNb4ZpTP1AiAX6HamhSe0T2s8pprLZwEQ3ixqnSe0xn6tobqdaa41pUbr3KZ11usAPa61REUH6NEa72idW11rSY3uLO4PeBRZu8fj8Xg8Ho/H4/F4PB6Px+PxeDyj+Af1zL6NZdUYmgAAAABJRU5ErkJggg==";

let _googleImg = null;
let _starImg = null;
async function getGoogleImg() {
  if (!_googleImg) _googleImg = await loadImage(Buffer.from(PNG_GOOGLE_B64, "base64"));
  return _googleImg;
}
async function getStarImg() {
  if (!_starImg) _starImg = await loadImage(Buffer.from(PNG_STAR_B64, "base64"));
  return _starImg;
}

// ── Decorative dashes helper ──────────────────────────────────────────────────
function drawDashes(ctx, cx, cy, count, len, gap, angle, color, lineW) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = lineW; ctx.lineCap = "round";
  ctx.translate(cx, cy); ctx.rotate(angle);
  for (let i = 0; i < count; i++) {
    const ox = (i - (count - 1) / 2) * (len + gap);
    ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox + len, 0); ctx.stroke();
  }
  ctx.restore();
}

// ── Core badge renderer ───────────────────────────────────────────────────────
async function drawV3Badge(ctx, w, h, name, opts = {}) {
  const {
    pillBg      = "#ffffff",
    pillShadow  = "rgba(0,0,0,0.28)",
    nameColor   = "#0d1b3e",
    underColor  = "#c8a882",
    dashColor   = "#d4b896",
    starBubbleBg= "#ffffff",
    font        = "bold 72px Georgia, 'Times New Roman', serif",
    yPos        = 0.72,
  } = opts;

  const gImg = await getGoogleImg();
  const sImg = await getStarImg();

  const pilH = Math.round(h * 0.135);
  const gSize = Math.round(pilH * 1.55);
  const gR = gSize / 2;

  ctx.font = font.replace("72px", `${Math.round(h * 0.095)}px`);
  const nameW = ctx.measureText(name).width;

  const innerPad = Math.round(pilH * 0.38);
  const gGap = Math.round(gR * 0.55);
  const pilW = gR + gGap + innerPad + nameW + innerPad;

  const cx = w / 2 + gR * 0.3;
  const cy = Math.round(h * yPos);
  const pilX = cx - pilW / 2 + gR * 0.6;
  const pilY = cy - pilH / 2;

  const dc = dashColor;
  drawDashes(ctx, pilX - gR - 10, cy - pilH * 0.6, 2, 14, 5, -0.5, dc, 3);
  drawDashes(ctx, pilX - gR - 18, cy + pilH * 0.3, 2, 10, 4, 0.3, dc, 2.5);
  drawDashes(ctx, pilX + pilW + 12, cy - pilH * 0.4, 2, 12, 4, 0.5, dc, 2.5);

  ctx.save();
  ctx.shadowColor = pillShadow; ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.arc(pilX - gGap, cy, gR, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.restore();
  ctx.drawImage(gImg, pilX - gGap - gR * 0.6, cy - gR * 0.6, gR * 1.2, gR * 1.2);

  const pilR = pilH / 2;
  ctx.save();
  ctx.shadowColor = pillShadow; ctx.shadowBlur = 22;
  roundRect(ctx, pilX, pilY, pilW, pilH, pilR);
  ctx.fillStyle = pillBg; ctx.fill();
  ctx.restore();

  const nameFs = Math.round(h * 0.095);
  ctx.font = `bold ${nameFs}px Georgia, 'Times New Roman', serif`;
  ctx.fillStyle = nameColor; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const nameX = pilX + gR + gGap * 0.1 + innerPad * 0.6;
  ctx.fillText(name, nameX, cy);

  const underW = nameW * 0.85;
  const underX = nameX + nameW * 0.05;
  const underY = cy + nameFs * 0.55;
  ctx.beginPath();
  ctx.moveTo(underX, underY);
  ctx.quadraticCurveTo(underX + underW / 2, underY + nameFs * 0.08, underX + underW, underY);
  ctx.strokeStyle = underColor; ctx.lineWidth = Math.round(nameFs * 0.055); ctx.lineCap = "round";
  ctx.stroke();

  const sbSize = Math.round(gSize * 0.75);
  const sbX = pilX + pilW - sbSize * 0.15;
  const sbY = pilY - sbSize * 0.55;
  ctx.save();
  ctx.shadowColor = pillShadow; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(sbX, sbY, sbSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = starBubbleBg; ctx.fill();
  ctx.restore();
  ctx.drawImage(sImg, sbX - sbSize * 0.38, sbY - sbSize * 0.38, sbSize * 0.76, sbSize * 0.76);
}

// ── Presets ───────────────────────────────────────────────────────────────────
const PRESETS = {
  "v3-classic": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{ pillBg:"#ffffff", nameColor:"#0d1b3e", underColor:"#c8a882", dashColor:"#d4b896", starBubbleBg:"#ffffff", yPos:0.72 });
  },
  "v3-dark": async (ctx,w,h,name) => {
    ctx.fillStyle="rgba(0,0,0,.22)"; ctx.fillRect(0,0,w,h);
    await drawV3Badge(ctx,w,h,name,{ pillBg:"#0d1b3e", nameColor:"#ffffff", underColor:"#f59e0b", dashColor:"#94a3b8", starBubbleBg:"#ffffff", yPos:0.72 });
  },
  "v3-blue": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{ pillBg:"#1d4ed8", nameColor:"#ffffff", underColor:"#fbbf24", dashColor:"#93c5fd", starBubbleBg:"#ffffff", yPos:0.72 });
  },
  "v3-rose": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{ pillBg:"#fff1f2", nameColor:"#881337", underColor:"#f43f5e", dashColor:"#fda4af", starBubbleBg:"#ffffff", yPos:0.72 });
  },
  "v3-teal": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{ pillBg:"#0f766e", nameColor:"#ffffff", underColor:"#fde047", dashColor:"#5eead4", starBubbleBg:"#ffffff", yPos:0.72 });
  },
  "v3-slate": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{ pillBg:"#1e293b", nameColor:"#f1f5f9", underColor:"#d97706", dashColor:"#64748b", starBubbleBg:"#ffffff", yPos:0.72 });
  },
  "v3-ivory": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{ pillBg:"#faf7f2", nameColor:"#78350f", underColor:"#b45309", dashColor:"#d4b896", starBubbleBg:"#ffffff", yPos:0.72 });
  },
  "v3-green": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{ pillBg:"#15803d", nameColor:"#ffffff", underColor:"#bbf7d0", dashColor:"#86efac", starBubbleBg:"#ffffff", yPos:0.72 });
  },
};

// ── GET /render ────────────────────────────────────────────────────────────────
app.get("/render", renderLimiter, async (req, res) => {
  try {
    const { template, name } = req.query;
    if (!template) return res.status(400).json({ error: "template param required" });

    const slug = String(template).replace(/[^a-z0-9-_]/gi, "");
    const cfg = await readConfigAsync(slug);
    if (!cfg) return res.status(404).json({ error: "Template not found" });

    let photoSrc = null;
    if (cfg.photo_data) {
      const matches = cfg.photo_data.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        photoSrc = Buffer.from(matches[2], "base64");
      }
    }
    if (!photoSrc) {
      const photoPath = findPhoto(slug);
      if (!photoPath) return res.status(404).json({ error: "Photo not found for this template" });
      photoSrc = photoPath;
    }

    const displayName = name ? String(name).trim().split(" ")[0] : "Cliente";

    const baseImage = await loadImage(photoSrc);
    const W = baseImage.width, H = baseImage.height;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(baseImage, 0, 0);

    const presetFn = cfg.preset_id && cfg.preset_id.startsWith("v3-") && PRESETS[cfg.preset_id];
    if (presetFn) {
      await presetFn(ctx, W, H, displayName);
    } else if (cfg.font_family || cfg.text_x_pct != null) {
      const xPct   = cfg.text_x_pct ?? 0.5;
      const yPct   = cfg.text_y_pct ?? 0.72;
      const tx     = Math.round(W * xPct);
      const ty     = Math.round(H * yPct);
      const fs     = cfg.font_size_pct != null
        ? Math.round(H * cfg.font_size_pct)
        : (cfg.font_size ?? Math.round(H * 0.09));
      const color  = cfg.font_color  ?? "#0d1b3e";
      const family = cfg.font_family ?? "Georgia, serif";
      const bold   = cfg.bold   ? "bold"   : "normal";
      const italic = cfg.italic ? "italic" : "normal";
      const shadow = cfg.shadow ?? false;
      const underline = cfg.underline ?? false;

      if (shadow) {
        ctx.shadowColor   = "rgba(0,0,0,0.45)";
        ctx.shadowBlur    = 12;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
      }

      ctx.font         = `${italic} ${bold} ${fs}px ${family}`;
      ctx.fillStyle    = color;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(displayName, tx, ty);

      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

      if (underline) {
        const tw = ctx.measureText(displayName).width;
        const uw = tw * 0.85;
        const ux = tx - uw / 2;
        const uy = ty + fs * 0.62;
        ctx.beginPath();
        ctx.moveTo(ux, uy);
        ctx.quadraticCurveTo(tx, uy + fs * 0.1, ux + uw, uy);
        ctx.strokeStyle = "#c8a882";
        ctx.lineWidth   = Math.max(2, Math.round(fs * 0.045));
        ctx.lineCap     = "round";
        ctx.stroke();
      }
    } else {
      const { box, text } = cfg;
      if (!box) throw new Error("No renderable config found (no box, no font_family, no preset_id)");
      const bx = box.x, by = box.y, bw = box.width, bh = box.height;
      const radius = box.radius ?? 12;
      const borderWidth = box.border_width ?? 0;
      const opacity = text.opacity ?? 1;

      ctx.save(); ctx.globalAlpha = opacity;
      roundRect(ctx, bx, by, bw, bh, radius);
      ctx.fillStyle = text.bg_color || "#ffffff"; ctx.fill();
      if (borderWidth > 0) { ctx.lineWidth = borderWidth; ctx.strokeStyle = box.border_color ?? "#fff"; ctx.stroke(); }
      ctx.restore();

      const fontWeight = text.bold ? "bold" : "normal";
      ctx.font = `${fontWeight} ${text.font_size || 40}px system-ui, sans-serif`;
      ctx.fillStyle = text.font_color || "#2563EB";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(displayName, bx + bw / 2, by + bh / 2);
    }

    const buffer = canvas.toBuffer("image/jpeg", { quality: 92 });
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(buffer);
  } catch (err) {
    console.error("Render error:", err);
    res.status(500).json({ error: "Render failed", detail: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "3.0.0", mongo: !!db });
});

// ── Start ──────────────────────────────────────────────────────────────────────
connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`ImgReview v3.0 running on port ${PORT}`);
    console.log(`Storage: ${db ? "MongoDB" : "filesystem fallback"}`);
  });
});

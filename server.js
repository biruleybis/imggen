const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { Resend } = require("resend");

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
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      tls: true,
      tlsInsecure: true,
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

  const fileBuffer = fs.readFileSync(req.file.path);
  const mime = req.file.mimetype || "image/jpeg";
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

// ── SVG assets embutidos (Google G + Estrela) ─────────────────────────────────
const SVG_GOOGLE = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <path fill="#EA4335" d="M24 9.5c3.14 0 5.95 1.08 8.17 2.86l6.1-6.1C34.46 2.99 29.5 1 24 1 14.82 1 6.98 6.48 3.25 14.27l7.1 5.52C12.18 13.42 17.64 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.5 24.5c0-1.64-.15-3.22-.42-4.75H24v9.5h12.67C35.53 33.27 32.3 36 28.3 37.3l7.08 5.5C40.41 38.48 46.5 32.13 46.5 24.5z"/>
  <path fill="#FBBC05" d="M10.35 28.21A14.57 14.57 0 0 1 9.5 24c0-1.47.2-2.89.55-4.21l-7.1-5.52A23.97 23.97 0 0 0 0 24c0 3.87.92 7.53 2.56 10.77l7.79-6.56z"/>
  <path fill="#34A853" d="M24 47c5.5 0 10.12-1.82 13.49-4.93l-7.08-5.5C28.64 37.97 26.45 38.5 24 38.5c-6.34 0-11.72-4.27-13.65-10.05l-7.79 6.56C6.8 41.48 14.72 47 24 47z"/>
</svg>`);

const SVG_STAR = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <path fill="#FFD700" d="M24 4l5.5 11.1 12.3 1.8-8.9 8.6 2.1 12.2L24 31.9l-10.9 5.8 2.1-12.2-8.9-8.6 12.3-1.8z"/>
  <path fill="#FFA000" d="M24 4l5.5 11.1 12.3 1.8-8.9 8.6 2.1 12.2L24 31.9V4z" opacity=".15"/>
</svg>`);

let _googleImg = null;
let _starImg = null;
async function getGoogleImg() {
  if (!_googleImg) _googleImg = await loadImage(SVG_GOOGLE);
  return _googleImg;
}
async function getStarImg() {
  if (!_starImg) _starImg = await loadImage(SVG_STAR);
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

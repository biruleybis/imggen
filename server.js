const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

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
  contentSecurityPolicy: false, // disabled so the panel's inline scripts work
}));

const renderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many requests, please slow down." },
});

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
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
app.get("/api/templates", (req, res) => {
  if (!fs.existsSync(TEMPLATES_DIR)) return res.json([]);
  const slugs = fs.readdirSync(TEMPLATES_DIR).filter((d) => {
    return fs.statSync(path.join(TEMPLATES_DIR, d)).isDirectory() && fs.existsSync(configPath(d));
  });
  const list = slugs.map((slug) => {
    const cfg = readConfig(slug);
    return { slug, label: cfg?.label || slug };
  });
  res.json(list);
});

// ── GET /api/templates/:slug ───────────────────────────────────────────────────
app.get("/api/templates/:slug", (req, res) => {
  const cfg = readConfig(req.params.slug);
  if (!cfg) return res.status(404).json({ error: "Template not found" });
  res.json(cfg);
});

// ── POST /api/templates/:slug/photo ───────────────────────────────────────────
app.post("/api/templates/:slug/photo", upload.single("photo"), (req, res) => {
  const { slug } = req.params;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  // Ensure config exists
  if (!fs.existsSync(configPath(slug))) {
    writeConfig(slug, {
      slug,
      label: slug,
      box: { x: 50, y: 50, width: 300, height: 80, radius: 12, border_width: 0, border_color: "#ffffff" },
      text: { font_size: 40, font_color: "#2563EB", bg_color: "#ffffff", bold: true, align: "center", opacity: 1 },
      icon: null,
    });
  }
  res.json({ ok: true, file: req.file.filename });
});

// ── POST /api/templates/:slug/icon ────────────────────────────────────────────
app.post("/api/templates/:slug/icon", upload.single("icon"), (req, res) => {
  const { slug } = req.params;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ ok: true, file: req.file.filename });
});

// ── DELETE /api/templates/:slug/icon ─────────────────────────────────────────
app.delete("/api/templates/:slug/icon", (req, res) => {
  const { slug } = req.params;
  for (const ext of [".png", ".svg", ".jpg", ".webp"]) {
    const p = path.join(templateDir(slug), "icon" + ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const cfg = readConfig(slug);
  if (cfg) { cfg.icon = null; writeConfig(slug, cfg); }
  res.json({ ok: true });
});

// ── PUT /api/templates/:slug ──────────────────────────────────────────────────
app.put("/api/templates/:slug", (req, res) => {
  const { slug } = req.params;
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid body" });
  writeConfig(slug, { ...body, slug });
  res.json({ ok: true });
});

// ── POST /api/templates (create new) ──────────────────────────────────────────
app.post("/api/templates", (req, res) => {
  const { label } = req.body || {};
  if (!label) return res.status(400).json({ error: "label is required" });
  const slug = slugify(label) || Date.now().toString();
  const dir = templateDir(slug);
  if (fs.existsSync(configPath(slug))) return res.status(409).json({ error: "Template already exists", slug });
  fs.mkdirSync(dir, { recursive: true });
  writeConfig(slug, {
    slug,
    label,
    box: { x: 50, y: 50, width: 300, height: 80, radius: 12, border_width: 0, border_color: "#ffffff" },
    text: { font_size: 40, font_color: "#2563EB", bg_color: "#ffffff", bold: true, align: "center", opacity: 1 },
    icon: null,
  });
  res.status(201).json({ slug, label });
});

// ── DELETE /api/templates/:slug ───────────────────────────────────────────────
app.delete("/api/templates/:slug", (req, res) => {
  const { slug } = req.params;
  const dir = templateDir(slug);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "Not found" });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// ── GET /template-image/:slug ─────────────────────────────────────────────────
app.get("/template-image/:slug", (req, res) => {
  const p = findPhoto(req.params.slug);
  if (!p) return res.status(404).send("No photo");
  res.sendFile(p);
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

// Cache de imagens SVG carregadas
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

// ── Core badge renderer (Google pill + star bubble) ───────────────────────────
// underlineColor: cor do sublinhado; pillBg: cor do fundo da pílula
async function drawV3Badge(ctx, w, h, name, opts = {}) {
  const {
    pillBg      = "#ffffff",
    pillShadow  = "rgba(0,0,0,0.28)",
    nameColor   = "#0d1b3e",
    underColor  = "#c8a882",        // rosé/dourado padrão
    dashColor   = "#d4b896",
    starBubbleBg= "#ffffff",
    font        = "bold 72px Georgia, 'Times New Roman', serif",
    yPos        = 0.72,             // posição Y centro da pílula (fração de h)
  } = opts;

  const gImg = await getGoogleImg();
  const sImg = await getStarImg();

  // Dimensões base
  const pilH = Math.round(h * 0.135);
  const gSize = Math.round(pilH * 1.55);   // círculo Google (maior que a pílula)
  const gR = gSize / 2;

  // Medir nome
  ctx.font = font.replace("72px", `${Math.round(h * 0.095)}px`);
  const nameW = ctx.measureText(name).width;

  const innerPad = Math.round(pilH * 0.38);
  const gGap = Math.round(gR * 0.55);      // sobreposição Google sai à esquerda
  const pilW = gR + gGap + innerPad + nameW + innerPad;

  const cx = w / 2 + gR * 0.3;             // ligeiramente direita para equilibrar Google
  const cy = Math.round(h * yPos);
  const pilX = cx - pilW / 2 + gR * 0.6;
  const pilY = cy - pilH / 2;

  // ── Tracinhos decorativos ──
  const dc = dashColor;
  drawDashes(ctx, pilX - gR - 10, cy - pilH * 0.6, 2, 14, 5, -0.5, dc, 3);
  drawDashes(ctx, pilX - gR - 18, cy + pilH * 0.3, 2, 10, 4, 0.3, dc, 2.5);
  drawDashes(ctx, pilX + pilW + 12, cy - pilH * 0.4, 2, 12, 4, 0.5, dc, 2.5);

  // ── Círculo branco do Google ──
  ctx.save();
  ctx.shadowColor = pillShadow; ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.arc(pilX - gGap, cy, gR, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.restore();
  // Logo G
  ctx.drawImage(gImg, pilX - gGap - gR * 0.6, cy - gR * 0.6, gR * 1.2, gR * 1.2);

  // ── Pílula branca do nome ──
  const pilR = pilH / 2;
  ctx.save();
  ctx.shadowColor = pillShadow; ctx.shadowBlur = 22;
  roundRect(ctx, pilX, pilY, pilW, pilH, pilR);
  ctx.fillStyle = pillBg; ctx.fill();
  ctx.restore();

  // ── Nome (fonte cursiva) ──
  const nameFs = Math.round(h * 0.095);
  ctx.font = `bold ${nameFs}px Georgia, 'Times New Roman', serif`;
  ctx.fillStyle = nameColor; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const nameX = pilX + gR + gGap * 0.1 + innerPad * 0.6;
  ctx.fillText(name, nameX, cy);

  // ── Sublinhado curvo (linha simples com espessura) ──
  const underW = nameW * 0.85;
  const underX = nameX + nameW * 0.05;
  const underY = cy + nameFs * 0.55;
  ctx.beginPath();
  ctx.moveTo(underX, underY);
  ctx.quadraticCurveTo(underX + underW / 2, underY + nameFs * 0.08, underX + underW, underY);
  ctx.strokeStyle = underColor; ctx.lineWidth = Math.round(nameFs * 0.055); ctx.lineCap = "round";
  ctx.stroke();

  // ── Bolha da estrela ──
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

// ── Preset render functions (V3 — Google badge style) ────────────────────────
const PRESETS = {

  // 1. Classic — pílula branca, sublinhado rosé, fundo neutro (universal)
  "v3-classic": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{
      pillBg:"#ffffff", nameColor:"#0d1b3e", underColor:"#c8a882",
      dashColor:"#d4b896", starBubbleBg:"#ffffff", yPos:0.72,
    });
  },

  // 2. Dark — pílula escura, nome claro, sublinhado dourado (universal)
  "v3-dark": async (ctx,w,h,name) => {
    ctx.fillStyle="rgba(0,0,0,.22)"; ctx.fillRect(0,0,w,h);
    await drawV3Badge(ctx,w,h,name,{
      pillBg:"#0d1b3e", nameColor:"#ffffff", underColor:"#f59e0b",
      dashColor:"#94a3b8", starBubbleBg:"#ffffff", yPos:0.72,
    });
  },

  // 3. Blue — pílula azul, nome branco, sublinhado âmbar (clínica/academia)
  "v3-blue": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{
      pillBg:"#1d4ed8", nameColor:"#ffffff", underColor:"#fbbf24",
      dashColor:"#93c5fd", starBubbleBg:"#ffffff", yPos:0.72,
    });
  },

  // 4. Rose — pílula rosé, nome vinho, sublinhado rosa (estética/beleza)
  "v3-rose": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{
      pillBg:"#fff1f2", nameColor:"#881337", underColor:"#f43f5e",
      dashColor:"#fda4af", starBubbleBg:"#ffffff", yPos:0.72,
    });
  },

  // 5. Teal — pílula teal, nome branco, sublinhado amarelo (clínica/saúde)
  "v3-teal": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{
      pillBg:"#0f766e", nameColor:"#ffffff", underColor:"#fde047",
      dashColor:"#5eead4", starBubbleBg:"#ffffff", yPos:0.72,
    });
  },

  // 6. Slate — pílula cinza escuro, nome branco, sublinhado âmbar (jurídico)
  "v3-slate": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{
      pillBg:"#1e293b", nameColor:"#f1f5f9", underColor:"#d97706",
      dashColor:"#64748b", starBubbleBg:"#ffffff", yPos:0.72,
    });
  },

  // 7. Ivory — pílula creme, nome marrom, sublinhado dourado (estética premium)
  "v3-ivory": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{
      pillBg:"#faf7f2", nameColor:"#78350f", underColor:"#b45309",
      dashColor:"#d4b896", starBubbleBg:"#ffffff", yPos:0.72,
    });
  },

  // 8. Green — pílula verde, nome branco, sublinhado lima (serviços/petshop)
  "v3-green": async (ctx,w,h,name) => {
    await drawV3Badge(ctx,w,h,name,{
      pillBg:"#15803d", nameColor:"#ffffff", underColor:"#bbf7d0",
      dashColor:"#86efac", starBubbleBg:"#ffffff", yPos:0.72,
    });
  },
};

// ── GET /render ────────────────────────────────────────────────────────────────
app.get("/render", renderLimiter, async (req, res) => {
  try {
    const { template, name } = req.query;
    if (!template) return res.status(400).json({ error: "template param required" });

    const slug = String(template).replace(/[^a-z0-9-_]/gi, "");
    const cfg = readConfig(slug);
    if (!cfg) return res.status(404).json({ error: "Template not found" });

    const photoPath = findPhoto(slug);
    if (!photoPath) return res.status(404).json({ error: "Photo not found for this template" });

    const displayName = name ? String(name).trim().split(" ")[0] : "Cliente";

    const baseImage = await loadImage(photoPath);
    const W = baseImage.width, H = baseImage.height;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");

    // Draw base photo
    ctx.drawImage(baseImage, 0, 0);

    // If preset is stored, use V3 badge preset renderer (may be async)
    const presetFn = cfg.preset_id && PRESETS[cfg.preset_id];
    if (presetFn) {
      await presetFn(ctx, W, H, displayName);
    } else if (cfg.font_family || cfg.text_x_pct != null) {
      // ── New font-overlay mode (v3.0 font tool) ──────────────────────────────
      const xPct   = cfg.text_x_pct ?? 0.5;
      const yPct   = cfg.text_y_pct ?? 0.72;
      const tx     = Math.round(W * xPct);
      const ty     = Math.round(H * yPct);
      const fs     = cfg.font_size   ?? Math.round(H * 0.09);
      const color  = cfg.font_color  ?? "#0d1b3e";
      const family = cfg.font_family ?? "Georgia, serif";
      const bold   = cfg.bold   ? "bold"   : "normal";
      const italic = cfg.italic ? "italic" : "normal";
      const shadow = cfg.shadow ?? false;
      const underline = cfg.underline ?? false;

      // Text shadow
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

      // Reset shadow before underline
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

      // Elegant curved underline
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
      // ── Legacy manual box render (backwards compat) ────────────────────────
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
app.get("/health", (req, res) => res.json({ status: "ok", version: "2.0.0" }));

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ImgReview v2.0 running on port ${PORT}`);
  console.log(`Panel: http://localhost:${PORT}`);
  console.log(`Render: http://localhost:${PORT}/render?template=SLUG&name=João`);
});

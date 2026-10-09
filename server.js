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

// ── Server-side preset helpers ────────────────────────────────────────────────
const C = {
  blue:"#2563EB",navy:"#0A1128",white:"#ffffff",slate:"#F8FAFC",
  gray:"#64748B",muted:"#94a3b8",gold:"#f59e0b",green:"#16a34a",
  teal:"#0d9488",rose:"#e11d48",pink:"#db2777",purple:"#7c3aed",
  amber:"#d97706",red:"#dc2626",sky:"#0284c7",warm:"#92400e",
};
function sName(ctx, name, cx, cy, fs, color) {
  ctx.font = `bold ${fs}px system-ui, -apple-system, sans-serif`; ctx.fillStyle = color;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(name + "!", cx, cy);
}
function sSub(ctx, text, cx, cy, fs, color) {
  ctx.font = `500 ${fs}px system-ui, -apple-system, sans-serif`; ctx.fillStyle = color;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
}

// ── Preset render functions (mirror of frontend PRESETS) ──────────────────────
const PRESETS = {
  // UNIVERSAL
  "u-rodape-clean": (ctx,w,h,name) => {
    const bh=Math.round(h*.18),by=h-bh;
    ctx.fillStyle="#fff"; ctx.fillRect(0,by,w,bh);
    ctx.font=`${Math.round(h*.04)}px system-ui, -apple-system, sans-serif`; ctx.fillStyle="#f59e0b";
    ctx.textAlign="center"; ctx.textBaseline="top"; ctx.fillText("⭐⭐⭐⭐⭐",w/2,by+bh*.1);
    sName(ctx,name,w/2,by+bh*.68,Math.round(h*.07),C.blue);
  },
  "u-pill-center": (ctx,w,h,name) => {
    const bw=Math.round(w*.62),bh=Math.round(h*.13),bx=(w-bw)/2,by=h*.42,r=bh/2;
    roundRect(ctx,bx,by,bw,bh,r); ctx.fillStyle=C.blue; ctx.fill();
    ctx.lineWidth=3; ctx.strokeStyle="#fff"; ctx.stroke();
    sName(ctx,name,w/2,by+bh/2,Math.round(h*.065),"#fff");
  },
  "u-obrigado": (ctx,w,h,name) => {
    const bw=w*.78,bh=h*.28,bx=(w-bw)/2,by=h*.35;
    ctx.save(); ctx.globalAlpha=.95; roundRect(ctx,bx,by,bw,bh,16); ctx.fillStyle="#fff"; ctx.fill(); ctx.restore();
    sSub(ctx,"Obrigado pela visita,",w/2,by+bh*.28,Math.round(h*.038),C.gray);
    sName(ctx,name,w/2,by+bh*.57,Math.round(h*.075),C.blue);
    sSub(ctx,"Sua opiniao faz a diferenca! Avalie ⭐",w/2,by+bh*.82,Math.round(h*.033),C.gold);
  },
  "u-assinatura": (ctx,w,h,name) => {
    const bw=w*.44,bh=h*.115,bx=w-bw-w*.04,by=h-bh-h*.05;
    ctx.save(); ctx.globalAlpha=.96; roundRect(ctx,bx,by,bw,bh,4); ctx.fillStyle=C.slate; ctx.fill(); ctx.restore();
    ctx.fillStyle=C.blue; ctx.fillRect(bx,by,4,bh);
    sSub(ctx,name,bx+bw/2+2,by+bh/2,Math.round(h*.052),C.navy);
  },
  "u-banner-topo": (ctx,w,h,name) => {
    const bh=Math.round(h*.16); ctx.fillStyle=C.blue; ctx.fillRect(0,0,w,bh);
    sSub(ctx,name+", avalie nossa empresa! ⭐",w/2,bh/2,Math.round(h*.065),"#fff");
  },
  "u-dupla": (ctx,w,h,name) => {
    const bw=w*.7,bh=h*.22,bx=(w-bw)/2,by=h*.76;
    ctx.save(); ctx.globalAlpha=.97; roundRect(ctx,bx,by,bw,bh,14); ctx.fillStyle=C.slate; ctx.fill(); ctx.restore();
    sName(ctx,name,w/2,by+bh*.35,Math.round(h*.068),C.navy);
    sSub(ctx,"Sua opiniao importa muito",w/2,by+bh*.72,Math.round(h*.035),C.blue);
  },
  "u-highlight": (ctx,w,h,name) => {
    ctx.fillStyle="rgba(10,17,40,.52)"; ctx.fillRect(0,0,w,h);
    const bw=w*.65,bh=h*.23,bx=(w-bw)/2,by=h*.38;
    ctx.save(); ctx.globalAlpha=.92; roundRect(ctx,bx,by,bw,bh,10); ctx.fillStyle=C.navy; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle=C.blue; ctx.stroke(); ctx.restore();
    sName(ctx,name,w/2,by+bh*.38,Math.round(h*.08),"#fff");
    sSub(ctx,"Conta pra gente como foi!",w/2,by+bh*.75,Math.round(h*.032),"#93c5fd");
  },
  "u-badge-lat": (ctx,w,h,name) => {
    const bw=Math.round(w*.18); ctx.fillStyle=C.blue; ctx.fillRect(0,0,bw,h);
    ctx.save(); ctx.translate(bw/2,h/2); ctx.rotate(-Math.PI/2);
    sSub(ctx,name+" — Avalie!",0,0,Math.round(h*.054),"#fff"); ctx.restore();
  },
  // CLÍNICAS
  "cl-confianca": (ctx,w,h,name) => {
    const bh=h*.22,by=h-bh;
    const grd=ctx.createLinearGradient(0,by,0,h);
    grd.addColorStop(0,"rgba(13,148,136,0)"); grd.addColorStop(1,"rgba(13,148,136,.92)");
    ctx.fillStyle=grd; ctx.fillRect(0,by,w,bh);
    sSub(ctx,"Obrigado por confiar em nossa equipe,",w/2,by+bh*.32,Math.round(h*.036),"#fff");
    sName(ctx,name,w/2,by+bh*.65,Math.round(h*.075),"#fff");
    sSub(ctx,"Deixe sua avaliacao ⭐",w/2,by+bh*.88,Math.round(h*.03),"#99f6e4");
  },
  "cl-saude": (ctx,w,h,name) => {
    const bw=w*.8,bh=h*.3,bx=(w-bw)/2,by=h*.33;
    ctx.save(); ctx.globalAlpha=.94; roundRect(ctx,bx,by,bw,bh,18); ctx.fillStyle="#fff"; ctx.fill(); ctx.restore();
    ctx.font=`${Math.round(h*.07)}px system-ui, -apple-system, sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("🏥",w/2,by+bh*.25);
    sName(ctx,name,w/2,by+bh*.55,Math.round(h*.07),C.teal);
    sSub(ctx,"Como foi sua consulta? Avalie!",w/2,by+bh*.82,Math.round(h*.033),C.gray);
  },
  "cl-missao": (ctx,w,h,name) => {
    const bh=Math.round(h*.17);
    const grd=ctx.createLinearGradient(0,0,0,bh);
    grd.addColorStop(0,C.teal); grd.addColorStop(1,"#065f46");
    ctx.fillStyle=grd; ctx.fillRect(0,0,w,bh);
    sSub(ctx,name+" — Sua saude, nossa missao",w/2,bh/2,Math.round(h*.055),"#fff");
  },
  "cl-consulta": (ctx,w,h,name) => {
    const bw=w*.72,bh=h*.26,bx=(w-bw)/2,by=h*.38;
    ctx.save(); ctx.globalAlpha=.96; roundRect(ctx,bx,by,bw,bh,12); ctx.fillStyle="#fff"; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle=C.teal; ctx.stroke(); ctx.restore();
    sSub(ctx,"Sua consulta foi concluida,",w/2,by+bh*.25,Math.round(h*.035),C.gray);
    sName(ctx,name,w/2,by+bh*.56,Math.round(h*.075),C.teal);
    sSub(ctx,"Avalie nosso atendimento ⭐",w/2,by+bh*.82,Math.round(h*.032),C.gold);
  },
  "cl-estrelas": (ctx,w,h,name) => {
    const bh=h*.2,by=h-bh; ctx.fillStyle=C.teal; ctx.fillRect(0,by,w,bh);
    sName(ctx,name+",",w/2,by+bh*.3,Math.round(h*.058),"#fff");
    sSub(ctx,"Como foi o seu atendimento? Avalie!",w/2,by+bh*.72,Math.round(h*.032),"#99f6e4");
  },
  // ACADEMIAS
  "ac-conquista": (ctx,w,h,name) => {
    ctx.fillStyle="rgba(0,0,0,.48)"; ctx.fillRect(0,0,w,h);
    const bw=w*.72,bh=h*.28,bx=(w-bw)/2,by=h*.35;
    roundRect(ctx,bx,by,bw,bh,6); ctx.fillStyle="#111827"; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle="#facc15"; ctx.stroke();
    sName(ctx,name,w/2,by+bh*.35,Math.round(h*.08),"#facc15");
    sSub(ctx,"Voce e parte da nossa familia! 💪",w/2,by+bh*.68,Math.round(h*.034),"#fff");
    sSub(ctx,"Avalie nossa academia ⭐",w/2,by+bh*.88,Math.round(h*.028),"#facc15");
  },
  "ac-energia": (ctx,w,h,name) => {
    const bh=Math.round(h*.18),by=h-bh;
    const grd=ctx.createLinearGradient(0,by,w,by+bh);
    grd.addColorStop(0,"#dc2626"); grd.addColorStop(1,"#ea580c");
    ctx.fillStyle=grd; ctx.fillRect(0,by,w,bh);
    sName(ctx,name,w/2,by+bh*.35,Math.round(h*.065),"#fff");
    sSub(ctx,"Sua energia transforma! ⚡ Avalie-nos",w/2,by+bh*.75,Math.round(h*.032),"#fed7aa");
  },
  "ac-evolucao": (ctx,w,h,name) => {
    const bw=w*.78,bh=h*.26,bx=(w-bw)/2,by=h*.37;
    ctx.save(); ctx.globalAlpha=.94; roundRect(ctx,bx,by,bw,bh,14); ctx.fillStyle="#111827"; ctx.fill(); ctx.restore();
    ctx.font=`${Math.round(h*.065)}px system-ui, -apple-system, sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("💪",w/2,by+bh*.25);
    sName(ctx,name,w/2,by+bh*.57,Math.round(h*.075),"#facc15");
    sSub(ctx,"Avalie nossa evolucao juntos!",w/2,by+bh*.84,Math.round(h*.03),"#9ca3af");
  },
  "ac-familia": (ctx,w,h,name) => {
    const bh=Math.round(h*.17); ctx.fillStyle="#dc2626"; ctx.fillRect(0,0,w,bh);
    sSub(ctx,name+" — Sua opiniao nos faz mais fortes!",w/2,bh/2,Math.round(h*.052),"#fff");
  },
  "ac-resultado": (ctx,w,h,name) => {
    const bw=w*.68,bh=h*.22,bx=(w-bw)/2,by=h*.76;
    ctx.save(); ctx.globalAlpha=.96; roundRect(ctx,bx,by,bw,bh,10); ctx.fillStyle="#111827"; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle="#facc15"; ctx.stroke(); ctx.restore();
    sName(ctx,name,w/2,by+bh*.35,Math.round(h*.068),"#facc15");
    sSub(ctx,"🏆 Resultado que fala por si!",w/2,by+bh*.72,Math.round(h*.034),"#fff");
  },
  // PET SHOP
  "pt-amor": (ctx,w,h,name) => {
    const bh=h*.22,by=h-bh; ctx.fillStyle="#f472b6"; ctx.fillRect(0,by,w,bh);
    sSub(ctx,"Obrigado por cuidar tao bem do seu pet,",w/2,by+bh*.28,Math.round(h*.035),"#fff");
    sName(ctx,name,w/2,by+bh*.6,Math.round(h*.072),"#fff");
    sSub(ctx,"🐾 Deixe sua avaliacao ⭐",w/2,by+bh*.87,Math.round(h*.03),"#fce7f3");
  },
  "pt-cuidado": (ctx,w,h,name) => {
    const bw=w*.78,bh=h*.28,bx=(w-bw)/2,by=h*.35;
    ctx.save(); ctx.globalAlpha=.94; roundRect(ctx,bx,by,bw,bh,20); ctx.fillStyle="#fff"; ctx.fill(); ctx.restore();
    ctx.font=`${Math.round(h*.07)}px system-ui, -apple-system, sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("🐾",w/2,by+bh*.24);
    sName(ctx,name,w/2,by+bh*.55,Math.round(h*.072),"#db2777");
    sSub(ctx,"Como foi o atendimento do seu pet? Avalie!",w/2,by+bh*.82,Math.round(h*.03),C.gray);
  },
  "pt-familia": (ctx,w,h,name) => {
    const bh=Math.round(h*.17);
    const grd=ctx.createLinearGradient(0,0,w,0);
    grd.addColorStop(0,"#db2777"); grd.addColorStop(1,"#9333ea");
    ctx.fillStyle=grd; ctx.fillRect(0,0,w,bh);
    sSub(ctx,name+" 🐾 — Obrigado por fazer parte da familia!",w/2,bh/2,Math.round(h*.048),"#fff");
  },
  "pt-servico": (ctx,w,h,name) => {
    const bw=w*.74,bh=h*.25,bx=(w-bw)/2,by=h*.38;
    ctx.save(); ctx.globalAlpha=.96; roundRect(ctx,bx,by,bw,bh,14); ctx.fillStyle="#fff"; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle="#f472b6"; ctx.stroke(); ctx.restore();
    sSub(ctx,"Banho & Tosa concluido! ✂️",w/2,by+bh*.27,Math.round(h*.038),C.gray);
    sName(ctx,name,w/2,by+bh*.57,Math.round(h*.075),"#db2777");
    sSub(ctx,"Como foi o servico? Avalie ⭐",w/2,by+bh*.84,Math.round(h*.032),C.gold);
  },
  "pt-melhor": (ctx,w,h,name) => {
    const bh=h*.2,by=h-bh; ctx.fillStyle="#7e22ce"; ctx.fillRect(0,by,w,bh);
    sName(ctx,name+",",w/2,by+bh*.3,Math.round(h*.058),"#fff");
    sSub(ctx,"Conte como foi o cuidado do seu pet 🐾",w/2,by+bh*.72,Math.round(h*.03),"#e9d5ff");
  },
  // ESTÉTICA
  "es-brilho": (ctx,w,h,name) => {
    ctx.fillStyle="rgba(0,0,0,.4)"; ctx.fillRect(0,0,w,h);
    const bw=w*.75,bh=h*.28,bx=(w-bw)/2,by=h*.36;
    ctx.save(); ctx.globalAlpha=.92; roundRect(ctx,bx,by,bw,bh,16); ctx.fillStyle="#1c0a0a"; ctx.fill();
    ctx.lineWidth=1; ctx.strokeStyle="#d97706"; ctx.stroke(); ctx.restore();
    sName(ctx,name,w/2,by+bh*.35,Math.round(h*.08),"#fde68a");
    sSub(ctx,"Como foi sua experiencia conosco? ✨",w/2,by+bh*.66,Math.round(h*.036),"#fff");
    sSub(ctx,"Avalie e deixe seu feedback",w/2,by+bh*.88,Math.round(h*.028),"#d97706");
  },
  "es-experiencia": (ctx,w,h,name) => {
    const bh=h*.22,by=h-bh;
    const grd=ctx.createLinearGradient(0,by,0,h);
    grd.addColorStop(0,"rgba(219,39,119,0)"); grd.addColorStop(1,"rgba(219,39,119,.9)");
    ctx.fillStyle=grd; ctx.fillRect(0,by,w,bh);
    sSub(ctx,"Como foi sua experiencia conosco,",w/2,by+bh*.3,Math.round(h*.036),"#fff");
    sName(ctx,name,w/2,by+bh*.62,Math.round(h*.072),"#fff");
    sSub(ctx,"Deixe seu feedback ⭐",w/2,by+bh*.88,Math.round(h*.03),"#fce7f3");
  },
  "es-exclusivo": (ctx,w,h,name) => {
    const bw=w*.78,bh=h*.28,bx=(w-bw)/2,by=h*.35;
    ctx.save(); ctx.globalAlpha=.95; roundRect(ctx,bx,by,bw,bh,20); ctx.fillStyle="#fff7ed"; ctx.fill(); ctx.restore();
    ctx.font=`${Math.round(h*.065)}px system-ui, -apple-system, sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("👑",w/2,by+bh*.24);
    sName(ctx,name,w/2,by+bh*.55,Math.round(h*.072),"#92400e");
    sSub(ctx,"tratamento de excelencia para voce!",w/2,by+bh*.82,Math.round(h*.032),C.amber);
  },
  "es-relaxa": (ctx,w,h,name) => {
    const bh=Math.round(h*.17);
    const grd=ctx.createLinearGradient(0,0,w,0);
    grd.addColorStop(0,"#7c3aed"); grd.addColorStop(1,"#db2777");
    ctx.fillStyle=grd; ctx.fillRect(0,0,w,bh);
    sSub(ctx,name+" 🧘 — Como foi seu momento?",w/2,bh/2,Math.round(h*.052),"#fff");
  },
  "es-autocuidado": (ctx,w,h,name) => {
    const bw=w*.72,bh=h*.22,bx=(w-bw)/2,by=h*.76;
    ctx.save(); ctx.globalAlpha=.97; roundRect(ctx,bx,by,bw,bh,12); ctx.fillStyle="#fff0f6"; ctx.fill();
    ctx.lineWidth=1.5; ctx.strokeStyle="#f472b6"; ctx.stroke(); ctx.restore();
    sName(ctx,name,w/2,by+bh*.34,Math.round(h*.068),"#be185d");
    sSub(ctx,"🌸 Conte como foi sua experiencia. Avalie!",w/2,by+bh*.73,Math.round(h*.033),"#db2777");
  },
  // JURÍDICO
  "ju-confianca": (ctx,w,h,name) => {
    ctx.fillStyle="rgba(10,17,40,.5)"; ctx.fillRect(0,0,w,h);
    const bw=w*.74,bh=h*.26,bx=(w-bw)/2,by=h*.37;
    ctx.save(); ctx.globalAlpha=.95; roundRect(ctx,bx,by,bw,bh,6); ctx.fillStyle="#0f172a"; ctx.fill();
    ctx.lineWidth=1; ctx.strokeStyle="#94a3b8"; ctx.stroke(); ctx.restore();
    sSub(ctx,"Foi um prazer atende-lo,",w/2,by+bh*.28,Math.round(h*.036),"#94a3b8");
    sName(ctx,name,w/2,by+bh*.58,Math.round(h*.078),"#fff");
    sSub(ctx,"Sua avaliacao fortalece nossa reputacao.",w/2,by+bh*.84,Math.round(h*.03),"#64748b");
  },
  "ju-reputacao": (ctx,w,h,name) => {
    const bh=h*.2,by=h-bh; ctx.fillStyle="#0f172a"; ctx.fillRect(0,by,w,bh);
    ctx.lineWidth=1; ctx.strokeStyle="#334155";
    ctx.beginPath(); ctx.moveTo(0,by); ctx.lineTo(w,by); ctx.stroke();
    sName(ctx,name,w/2,by+bh*.35,Math.round(h*.062),"#fff");
    sSub(ctx,"⚖️ Avalie nosso atendimento — sua opiniao importa",w/2,by+bh*.72,Math.round(h*.03),"#94a3b8");
  },
  "ju-sessao": (ctx,w,h,name) => {
    const bw=w*.78,bh=h*.28,bx=(w-bw)/2,by=h*.35;
    ctx.save(); ctx.globalAlpha=.95; roundRect(ctx,bx,by,bw,bh,14); ctx.fillStyle="#fff"; ctx.fill(); ctx.restore();
    ctx.font=`${Math.round(h*.062)}px system-ui, -apple-system, sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("🧠",w/2,by+bh*.23);
    sSub(ctx,"Obrigado pela sessao,",w/2,by+bh*.5,Math.round(h*.036),C.gray);
    sName(ctx,name,w/2,by+bh*.73,Math.round(h*.068),"#7c3aed");
    sSub(ctx,"Deixe seu feedback ⭐",w/2,by+bh*.91,Math.round(h*.028),C.gold);
  },
  "ju-elegante": (ctx,w,h,name) => {
    const bh=Math.round(h*.15); ctx.fillStyle="#1e293b"; ctx.fillRect(0,0,w,bh);
    sSub(ctx,name+" — Obrigado pela confianca em nosso trabalho.",w/2,bh/2,Math.round(h*.046),"#e2e8f0");
  },
  "ju-parceria": (ctx,w,h,name) => {
    const bw=w*.7,bh=h*.22,bx=(w-bw)/2,by=h*.76;
    ctx.save(); ctx.globalAlpha=.96; roundRect(ctx,bx,by,bw,bh,8); ctx.fillStyle="#0f172a"; ctx.fill();
    ctx.lineWidth=1.5; ctx.strokeStyle="#7c3aed"; ctx.stroke(); ctx.restore();
    sName(ctx,name,w/2,by+bh*.34,Math.round(h*.068),"#fff");
    sSub(ctx,"🤝 Parceria que constroi resultados. Avalie!",w/2,by+bh*.73,Math.round(h*.032),"#a78bfa");
  },
  // SERVIÇOS
  "sv-resolvido": (ctx,w,h,name) => {
    const bh=h*.22,by=h-bh; ctx.fillStyle=C.green; ctx.fillRect(0,by,w,bh);
    sSub(ctx,"✅ Servico concluido com sucesso,",w/2,by+bh*.28,Math.round(h*.036),"#fff");
    sName(ctx,name,w/2,by+bh*.6,Math.round(h*.072),"#fff");
    sSub(ctx,"Como avalia nosso trabalho? ⭐",w/2,by+bh*.87,Math.round(h*.03),"#bbf7d0");
  },
  "sv-seguranca": (ctx,w,h,name) => {
    const bw=w*.78,bh=h*.28,bx=(w-bw)/2,by=h*.35;
    ctx.save(); ctx.globalAlpha=.94; roundRect(ctx,bx,by,bw,bh,14); ctx.fillStyle="#fff"; ctx.fill(); ctx.restore();
    ctx.font=`${Math.round(h*.065)}px system-ui, -apple-system, sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("🛡️",w/2,by+bh*.24);
    sName(ctx,name,w/2,by+bh*.54,Math.round(h*.073),C.green);
    sSub(ctx,"Sua casa protegida. Avalie nosso servico!",w/2,by+bh*.82,Math.round(h*.032),C.gray);
  },
  "sv-qualidade": (ctx,w,h,name) => {
    const bh=Math.round(h*.17); ctx.fillStyle=C.green; ctx.fillRect(0,0,w,bh);
    sSub(ctx,name+" 🔧 — Servico de qualidade ✔",w/2,bh/2,Math.round(h*.052),"#fff");
  },
  "sv-alivio": (ctx,w,h,name) => {
    ctx.fillStyle="rgba(0,0,0,.45)"; ctx.fillRect(0,0,w,h);
    const bw=w*.68,bh=h*.24,bx=(w-bw)/2,by=h*.38;
    ctx.save(); ctx.globalAlpha=.93; roundRect(ctx,bx,by,bw,bh,10); ctx.fillStyle="#052e16"; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle=C.green; ctx.stroke(); ctx.restore();
    sName(ctx,name,w/2,by+bh*.38,Math.round(h*.078),"#4ade80");
    sSub(ctx,"Problema resolvido! 😌 Avalie-nos!",w/2,by+bh*.75,Math.round(h*.034),"#fff");
  },
  "sv-profissional": (ctx,w,h,name) => {
    const bw=w*.7,bh=h*.22,bx=(w-bw)/2,by=h*.76;
    ctx.save(); ctx.globalAlpha=.96; roundRect(ctx,bx,by,bw,bh,10); ctx.fillStyle="#052e16"; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle="#4ade80"; ctx.stroke(); ctx.restore();
    sName(ctx,name,w/2,by+bh*.34,Math.round(h*.068),"#4ade80");
    sSub(ctx,"👷 Feito por profissionais. Avalie ⭐",w/2,by+bh*.73,Math.round(h*.032),"#fff");
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

    // If preset is stored, use preset renderer
    const presetFn = cfg.preset_id && PRESETS[cfg.preset_id];
    if (presetFn) {
      presetFn(ctx, W, H, displayName);
    } else {
      // Manual box render
      const { box, text, icon } = cfg;
      const bx = box.x, by = box.y, bw = box.width, bh = box.height;
      const radius = box.radius ?? 12;
      const borderWidth = box.border_width ?? 0;
      const borderColor = box.border_color ?? "#ffffff";
      const opacity = text.opacity ?? 1;

      ctx.save();
      ctx.globalAlpha = opacity;
      roundRect(ctx, bx, by, bw, bh, radius);
      ctx.fillStyle = text.bg_color || "#ffffff";
      ctx.fill();
      if (borderWidth > 0) { ctx.lineWidth = borderWidth; ctx.strokeStyle = borderColor; ctx.stroke(); }
      ctx.restore();

      // Icon
      const iconPath = findIcon(slug);
      let iconWidth = 0;
      if (iconPath && icon) {
        try {
          const iconImg = await loadImage(iconPath);
          const iconSize = icon.size ?? 40;
          const iconX = bx + (icon.x ?? 10);
          const iconY = by + (bh - iconSize) / 2;
          ctx.drawImage(iconImg, iconX, iconY, iconSize, iconSize);
          iconWidth = iconSize + (icon.x ?? 10) + 8;
        } catch (e) { /* icon failed silently */ }
      }

      // Text
      const fontWeight = text.bold ? "bold" : "normal";
      ctx.font = `${fontWeight} ${text.font_size || 40}px system-ui, -apple-system, sans-serif`;
      ctx.fillStyle = text.font_color || "#2563EB";
      ctx.textBaseline = "middle";
      const textY = by + bh / 2;
      const availableWidth = bw - iconWidth;
      const textAreaStart = bx + iconWidth;
      let textX;
      if (text.align === "center") { ctx.textAlign = "center"; textX = textAreaStart + availableWidth / 2; }
      else if (text.align === "right") { ctx.textAlign = "right"; textX = bx + bw - 16; }
      else { ctx.textAlign = "left"; textX = textAreaStart + 16; }
      ctx.fillText(displayName + "!", textX, textY);
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

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const TEMPLATES_DIR = path.join(__dirname, "templates");
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Multer - upload template images
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATES_DIR),
  filename: (req, file, cb) => {
    const slug = req.body.slug || Date.now().toString();
    const ext = path.extname(file.originalname);
    cb(null, `${slug}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// List all templates
app.get("/api/templates", (req, res) => {
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
  const templates = files.map((f) => {
    const config = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f)));
    return { slug: path.basename(f, ".json"), ...config };
  });
  res.json(templates);
});

// Get single template config
app.get("/api/templates/:slug", (req, res) => {
  const configPath = path.join(TEMPLATES_DIR, `${req.params.slug}.json`);
  if (!fs.existsSync(configPath)) return res.status(404).json({ error: "Template not found" });
  res.json(JSON.parse(fs.readFileSync(configPath)));
});

// Upload image + save config
app.post("/api/templates", upload.single("image"), (req, res) => {
  try {
    const { slug, label, box_x, box_y, box_width, box_height, font_size, font_color, bg_color, bold, align } = req.body;
    if (!slug || !req.file) return res.status(400).json({ error: "slug e imagem são obrigatórios" });

    // Rename uploaded file to slug
    const ext = path.extname(req.file.originalname);
    const correctName = `${slug}${ext}`;
    const correctPath = path.join(TEMPLATES_DIR, correctName);
    if (req.file.path !== correctPath) {
      fs.renameSync(req.file.path, correctPath);
    }

    const config = {
      label: label || slug,
      image: correctName,
      box: {
        x: parseInt(box_x) || 80,
        y: parseInt(box_y) || 400,
        width: parseInt(box_width) || 320,
        height: parseInt(box_height) || 70,
      },
      text: {
        font_size: parseInt(font_size) || 42,
        font_color: font_color || "#2b2bbf",
        bg_color: bg_color || "#ffffff",
        bold: bold === "true" || bold === true,
        align: align || "center",
      },
    };

    fs.writeFileSync(path.join(TEMPLATES_DIR, `${slug}.json`), JSON.stringify(config, null, 2));
    res.json({ success: true, slug, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update template config only (no image re-upload)
app.put("/api/templates/:slug", (req, res) => {
  try {
    const configPath = path.join(TEMPLATES_DIR, `${req.params.slug}.json`);
    if (!fs.existsSync(configPath)) return res.status(404).json({ error: "Template not found" });

    const existing = JSON.parse(fs.readFileSync(configPath));
    const { label, box_x, box_y, box_width, box_height, font_size, font_color, bg_color, bold, align } = req.body;

    const updated = {
      ...existing,
      label: label || existing.label,
      box: {
        x: parseInt(box_x) ?? existing.box.x,
        y: parseInt(box_y) ?? existing.box.y,
        width: parseInt(box_width) ?? existing.box.width,
        height: parseInt(box_height) ?? existing.box.height,
      },
      text: {
        font_size: parseInt(font_size) ?? existing.text.font_size,
        font_color: font_color || existing.text.font_color,
        bg_color: bg_color || existing.text.bg_color,
        bold: bold !== undefined ? (bold === "true" || bold === true) : existing.text.bold,
        align: align || existing.text.align,
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
    res.json({ success: true, config: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete template
app.delete("/api/templates/:slug", (req, res) => {
  const slug = req.params.slug;
  const configPath = path.join(TEMPLATES_DIR, `${slug}.json`);
  if (!fs.existsSync(configPath)) return res.status(404).json({ error: "Not found" });

  const config = JSON.parse(fs.readFileSync(configPath));
  const imgPath = path.join(TEMPLATES_DIR, config.image);
  if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  fs.unlinkSync(configPath);
  res.json({ success: true });
});

// ─── RENDER ENDPOINT ──────────────────────────────────────────────────────────
// GET /render?template=ivens&name=Bruno
app.get("/render", async (req, res) => {
  try {
    const { template, name } = req.query;
    if (!template) return res.status(400).send("Missing template");

    const configPath = path.join(TEMPLATES_DIR, `${template}.json`);
    if (!fs.existsSync(configPath)) return res.status(404).send("Template not found");

    const config = JSON.parse(fs.readFileSync(configPath));
    const imgPath = path.join(TEMPLATES_DIR, config.image);
    if (!fs.existsSync(imgPath)) return res.status(404).send("Image file not found");

    const displayName = name ? decodeURIComponent(name) : "Cliente";
    const { box, text } = config;

    // Load image and get dimensions
    const baseImage = await loadImage(imgPath);
    const canvas = createCanvas(baseImage.width, baseImage.height);
    const ctx = canvas.getContext("2d");

    // Draw base image
    ctx.drawImage(baseImage, 0, 0);

    // Draw background box
    ctx.fillStyle = text.bg_color;
    const radius = 8;
    ctx.beginPath();
    ctx.moveTo(box.x + radius, box.y);
    ctx.lineTo(box.x + box.width - radius, box.y);
    ctx.quadraticCurveTo(box.x + box.width, box.y, box.x + box.width, box.y + radius);
    ctx.lineTo(box.x + box.width, box.y + box.height - radius);
    ctx.quadraticCurveTo(box.x + box.width, box.y + box.height, box.x + box.width - radius, box.y + box.height);
    ctx.lineTo(box.x + radius, box.y + box.height);
    ctx.quadraticCurveTo(box.x, box.y + box.height, box.x, box.y + box.height - radius);
    ctx.lineTo(box.x, box.y + radius);
    ctx.quadraticCurveTo(box.x, box.y, box.x + radius, box.y);
    ctx.closePath();
    ctx.fill();

    // Draw text
    const fontWeight = text.bold ? "bold" : "normal";
    ctx.font = `${fontWeight} ${text.font_size}px serif`;
    ctx.fillStyle = text.font_color;
    ctx.textAlign = text.align || "center";

    const textX =
      text.align === "left" ? box.x + 12 : text.align === "right" ? box.x + box.width - 12 : box.x + box.width / 2;
    const textY = box.y + box.height / 2 + text.font_size * 0.35;

    ctx.fillText(displayName + "!", textX, textY);

    const buffer = canvas.toBuffer("image/jpeg");
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" });
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).send("Render error: " + e.message);
  }
});

// Serve template images (for preview in panel)
app.get("/template-image/:slug", (req, res) => {
  const configPath = path.join(TEMPLATES_DIR, `${req.params.slug}.json`);
  if (!fs.existsSync(configPath)) return res.status(404).send("Not found");
  const config = JSON.parse(fs.readFileSync(configPath));
  const imgPath = path.join(TEMPLATES_DIR, config.image);
  if (!fs.existsSync(imgPath)) return res.status(404).send("Image not found");
  res.sendFile(imgPath);
});

app.listen(PORT, () => console.log(`ImgGen running on http://localhost:${PORT}`));

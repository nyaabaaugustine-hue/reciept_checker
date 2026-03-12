// Run with: node generate-icons.js
// Generates SVG-based PNG icons for the PWA manifest

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const outDir = path.join(__dirname, 'public', 'icons');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0d9488';
  roundRect(ctx, 0, 0, size, size, size * 0.22);
  ctx.fill();

  // Shield shape
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.35;

  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.75, cy - r * 0.5);
  ctx.lineTo(cx + r * 0.75, cy + r * 0.2);
  ctx.quadraticCurveTo(cx + r * 0.75, cy + r * 1.0, cx, cy + r * 1.1);
  ctx.quadraticCurveTo(cx - r * 0.75, cy + r * 1.0, cx - r * 0.75, cy + r * 0.2);
  ctx.lineTo(cx - r * 0.75, cy - r * 0.5);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = size * 0.04;
  ctx.stroke();

  // Checkmark
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.32, cy + r * 0.1);
  ctx.lineTo(cx - r * 0.05, cy + r * 0.45);
  ctx.lineTo(cx + r * 0.4, cy - r * 0.25);
  ctx.strokeStyle = 'white';
  ctx.lineWidth = size * 0.08;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), buffer);
  console.log(`✓ icon-${size}.png`);
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// generate-icons-svg.js — no dependencies needed, uses built-in Node modules
// Run: node generate-icons-svg.js

const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

sizes.forEach(size => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0d9488"/>
  <path d="M50 15 L78 28 L78 55 Q78 75 50 88 Q22 75 22 55 L22 28 Z" fill="rgba(255,255,255,0.2)" stroke="white" stroke-width="3.5"/>
  <polyline points="33,51 44,64 67,38" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  // Write as .svg files (browsers accept svg as icon source)
  fs.writeFileSync(path.join(outDir, `icon-${size}.svg`), svg);
  console.log(`✓ icon-${size}.svg`);
});

console.log('\nDone! Update manifest.json to use .svg icons or run with canvas for .png');

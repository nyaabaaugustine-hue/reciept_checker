// create-pwa-icons.js — Creates real PNG icons using pure Node.js
// No npm packages needed. Uses a minimal BMP→PNG approach.
// Run: node create-pwa-icons.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const outDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// Create SVG icons (work on all modern browsers for PWA)
const sizes = [192, 512];

sizes.forEach(size => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0d9488"/>
  <path d="M50 14 L79 28 L79 56 Q79 76 50 89 Q21 76 21 56 L21 28 Z" fill="rgba(255,255,255,0.18)" stroke="white" stroke-width="3"/>
  <polyline points="33,51 44,64 68,38" fill="none" stroke="white" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  fs.writeFileSync(path.join(outDir, `icon-${size}.svg`), svg);
  console.log(`✓ icon-${size}.svg`);
});

// Also write a favicon.svg
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0d9488"/>
  <path d="M50 14 L79 28 L79 56 Q79 76 50 89 Q21 76 21 56 L21 28 Z" fill="rgba(255,255,255,0.18)" stroke="white" stroke-width="3"/>
  <polyline points="33,51 44,64 68,38" fill="none" stroke="white" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
fs.writeFileSync(path.join(__dirname, 'public', 'favicon.svg'), faviconSvg);

console.log('\n✅ Icons created in public/icons/');
console.log('📌 Update public/manifest.json to use these .svg icons');
console.log('📌 For real PNG icons, run: npm install canvas && node generate-icons.js');

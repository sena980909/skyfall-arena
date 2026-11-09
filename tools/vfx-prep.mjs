// VFX sprite prep: flatten onto black, apply edge mask so additive sprites have no visible quad border.
// usage: node tools/vfx-prep.mjs <src.png> <dst.png> <mode: radial|band> [size]
import sharp from 'sharp';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const [src, dst, mode = 'radial', sizeArg, cropArg] = process.argv.slice(2);
const crop = cropArg ? Number(cropArg) : 1; // radial: keep the center fraction of the square
if (!src || !dst) { console.error('usage: vfx-prep <src> <dst> <radial|band> [size]'); process.exit(1); }
const BACKUP = 'tools/.backup';
mkdirSync(BACKUP, { recursive: true });
if (existsSync(dst)) { const b = join(BACKUP, basename(dst)); if (!existsSync(b)) copyFileSync(dst, b); }

const meta = await sharp(src).metadata();
console.log('src', meta.width, meta.height, 'channels', meta.channels, 'alpha', meta.hasAlpha);

let img = sharp(src).flatten({ background: '#000000' });
let w = meta.width, h = meta.height;
if (mode === 'radial' && crop < 1) {
  const cw = Math.round(w * crop), ch = Math.round(h * crop);
  img = img.extract({ left: Math.round((w - cw) / 2), top: Math.round((h - ch) / 2), width: cw, height: ch });
  w = cw; h = ch;
}
if (mode === 'band') {
  // keep the horizontal band around the streak (center 32% of height)
  const bh = Math.round(h * 0.32);
  img = img.extract({ left: 0, top: Math.round((h - bh) / 2), width: w, height: bh });
  h = bh;
}
if (sizeArg) {
  const size = Number(sizeArg);
  const nh = Math.round(h * size / w);
  img = img.resize(size, nh);
  w = size; h = nh;
}
// mask: radial falloff (sprite) or horizontal/vertical fade (band)
const maskSvg = mode === 'band'
  ? `<svg width="${w}" height="${h}"><defs>
      <linearGradient id="gx" x1="0" x2="1"><stop offset="0" stop-color="#000"/><stop offset="0.06" stop-color="#fff"/><stop offset="0.94" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
      <linearGradient id="gy" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset="0.18" stop-color="#fff"/><stop offset="0.82" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
      <mask id="m"><rect width="100%" height="100%" fill="url(#gy)"/></mask></defs>
      <rect width="100%" height="100%" fill="url(#gx)" mask="url(#m)"/></svg>`
  : `<svg width="${w}" height="${h}"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="0.62" stop-color="#fff"/><stop offset="0.92" stop-color="#000"/><stop offset="1" stop-color="#000"/></radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/></svg>`;
const mask = Buffer.from(maskSvg);
const out = await img.composite([{ input: mask, blend: 'multiply' }]).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
await sharp(out).toFile(dst);
const o = await sharp(dst).metadata();
console.log('dst', dst, o.width, o.height, (o.size / 1024).toFixed(0) + 'KB');

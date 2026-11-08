// GLB 최적화: node tools/optimize-glb.mjs
// - raven.glb / pulse_rifle.glb: 텍스처 1K WebP 압축 + dedup/prune
// - raven_*.glb (애니메이션): 메시·스킨·머티리얼·텍스처 제거, 본 노드 + 애니메이션만 남김
// 원본은 tools/.backup/ 에 보관
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'public/assets/models';
const BACKUP = 'tools/.backup';
mkdirSync(BACKUP, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const mb = (f) => (statSync(f).size / 1024 / 1024).toFixed(2) + ' MB';

function backup(file) {
  const dst = join(BACKUP, file.split(/[\\/]/).pop());
  if (!existsSync(dst)) copyFileSync(file, dst);
}

async function optimizeTextured(file, size) {
  const before = mb(file);
  backup(file);
  const doc = await io.read(file);
  await doc.transform(
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 85 }),
    prune(),
  );
  await io.write(file, doc);
  console.log(`${file}: ${before} → ${mb(file)}`);
}

async function stripToAnimation(file) {
  const before = mb(file);
  backup(file);
  const doc = await io.read(file);
  const root = doc.getRoot();
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const m of root.listMaterials()) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  // 애니메이션 채널이 참조하는 노드는 prune이 유지한다
  await doc.transform(resample(), prune({ keepLeaves: true }));
  await io.write(file, doc);
  const anims = root.listAnimations().map((a) => a.getName()).join(', ');
  console.log(`${file}: ${before} → ${mb(file)}  [${anims}]`);
}

const targets = process.argv.slice(2);
const all = targets.length === 0;
if (all || targets.includes('raven')) await optimizeTextured(join(DIR, 'raven.glb'), 1024);
if (all || targets.includes('rifle')) await optimizeTextured(join(DIR, 'pulse_rifle.glb'), 1024);
if (all || targets.includes('anim')) {
  for (const n of ['idle', 'run', 'shoot', 'death', 'strafe', 'aim']) await stripToAnimation(join(DIR, `raven_${n}.glb`));
}

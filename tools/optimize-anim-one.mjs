// 단일 애니메이션 GLB를 본+클립만 남기도록 축소: node tools/optimize-anim-one.mjs <file> [...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, resample } from '@gltf-transform/functions';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
mkdirSync('tools/.backup', { recursive: true });
for (const file of process.argv.slice(2)) {
  const before = (statSync(file).size / 1048576).toFixed(2);
  const bk = join('tools/.backup', file.split(/[\/]/).pop());
  if (!existsSync(bk)) copyFileSync(file, bk);
  const doc = await io.read(file);
  const root = doc.getRoot();
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const m of root.listMaterials()) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  await doc.transform(resample(), prune({ keepLeaves: true }));
  await io.write(file, doc);
  console.log(`${file}: ${before} MB -> ${(statSync(file).size / 1048576).toFixed(2)} MB [${root.listAnimations().map((a) => a.getName()).join(', ')}]`);
}

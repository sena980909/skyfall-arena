// Higgsfield rigged character -> files for the web, shape and skeleton untouched.
//   node tools/pack-character.mjs <dir with idle.glb run.glb ...> <out prefix, e.g. public/assets/models/enemy>
// - <prefix>.glb: the idle file with its mesh, skin and textures (WebP, metal/roughness map dropped)
// - <prefix>_<clip>.glb: every file reduced to its animation (mesh, skin, materials and textures removed)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dir, prefix] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const mb = (f) => (statSync(f).size / 1048576).toFixed(2) + ' MB';
for (const file of readdirSync(dir).filter((f) => f.endsWith('.glb'))) {
  const clip = file.replace('.glb', '');
  if (clip === 'idle') {
    const doc = await io.read(join(dir, file));
    for (const mat of doc.getRoot().listMaterials()) {
      mat.setMetallicRoughnessTexture(null);
      mat.setOcclusionTexture(null);
    }
    await doc.transform(
      dedup(), prune(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /baseColor|emissive/, resize: [1024, 1024], quality: 86 }),
      textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /normal/, resize: [1024, 1024], quality: 88 }),
    );
    await io.write(prefix + '.glb', doc);
    console.log(`${file} ${mb(join(dir, file))} -> ${prefix}.glb ${mb(prefix + '.glb')}`);
  }
  const doc = await io.read(join(dir, file));
  const root = doc.getRoot();
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const m of root.listMaterials()) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  await doc.transform(resample(), prune({ keepLeaves: true }));
  const out = `${prefix}_${clip}.glb`;
  await io.write(out, doc);
  console.log(`${file} -> ${out} ${mb(out)}  [${root.listAnimations().map((a) => a.getName()).join(', ')}]`);
}

// Shrink a Higgsfield GLB for the web without touching its shape.
//   node tools/pack-generated.mjs <in.glb> <out.glb> [colour size=2048] [normal size=1024]
// - colour texture resized to WebP, normal map to WebP at its own size
// - the metal/roughness/occlusion map is dropped (the game sets those as constants)
// - vertex data packed with meshopt (quantised positions, no decimation: every triangle stays)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { statSync } from 'node:fs';

const [src, dst, colour = '2048', normal = '1024', mode = ''] = process.argv.slice(2);
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(src);
let tris = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
for (const mat of doc.getRoot().listMaterials()) {
  mat.setMetallicRoughnessTexture(null);
  mat.setOcclusionTexture(null);
}
await doc.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /baseColor|emissive/, resize: [+colour, +colour], quality: 86 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /normal/, resize: [+normal, +normal], quality: 88 }),
  // 'plain' keeps the vertex data as floats (effect meshes, whose geometry the game re-orients at load)
  ...(mode === 'plain' ? [] : [meshopt({ encoder: MeshoptEncoder, level: 'medium' })]),
);
await io.write(dst, doc);
const mb = (f) => (statSync(f).size / 1048576).toFixed(2) + ' MB';
console.log(`${src} ${mb(src)} -> ${dst} ${mb(dst)}  triangles ${tris}`);

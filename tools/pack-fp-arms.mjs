// Higgsfield rigged character -> first-person arms for the web. Shape and skeleton untouched: triangles are only dropped.
//   node tools/pack-fp-arms.mjs <rigged.glb> <out.glb> [colour size=2048] [normal size=1024]
// Keeps the triangles that move with the arm bones (upper arm, forearm, hand); the torso, head and legs never enter the
// first-person view. The whole skeleton stays, so the game poses it the same way as the full body.
// Vertex data is packed with meshopt like the other generated models (no decimation).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { statSync } from 'node:fs';

const [src, dst, colour = '2048', normal = '1024'] = process.argv.slice(2);
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(src);
const root = doc.getRoot();
for (const a of root.listAnimations()) a.dispose();
const ARM = /^(Left|Right)(Arm|ForeArm|Hand)$/;
let before = 0;
let after = 0;
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  const skin = node.getSkin();
  if (!mesh || !skin) continue;
  const armJoint = skin.listJoints().map((j) => ARM.test(j.getName()));
  for (const prim of mesh.listPrimitives()) {
    const joints = prim.getAttribute('JOINTS_0');
    const weights = prim.getAttribute('WEIGHTS_0');
    const n = joints.getCount();
    const keepV = new Uint8Array(n);
    const j = [0, 0, 0, 0];
    const w = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      joints.getElement(i, j);
      weights.getElement(i, w);
      let sum = 0;
      let arm = 0;
      for (let k = 0; k < 4; k++) {
        sum += w[k];
        if (armJoint[j[k]]) arm += w[k];
      }
      keepV[i] = arm > 0.5 * sum ? 1 : 0;
    }
    const idx = prim.getIndices().getArray();
    before += idx.length / 3;
    const kept = [];
    for (let t = 0; t < idx.length; t += 3) if (keepV[idx[t]] && keepV[idx[t + 1]] && keepV[idx[t + 2]]) kept.push(idx[t], idx[t + 1], idx[t + 2]);
    after += kept.length / 3;
    const remap = new Int32Array(n).fill(-1);
    let count = 0;
    for (const v of kept) if (remap[v] < 0) remap[v] = count++;
    for (const sem of prim.listSemantics()) {
      const a = prim.getAttribute(sem);
      const size = a.getElementSize();
      const from = a.getArray();
      const to = new from.constructor(count * size);
      for (let i = 0; i < n; i++) {
        if (remap[i] < 0) continue;
        for (let k = 0; k < size; k++) to[remap[i] * size + k] = from[i * size + k];
      }
      prim.setAttribute(sem, doc.createAccessor().setType(a.getType()).setNormalized(a.getNormalized()).setArray(to));
    }
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(kept, (v) => remap[v])));
  }
}
for (const mat of root.listMaterials()) {
  mat.setMetallicRoughnessTexture(null);
  mat.setOcclusionTexture(null);
}
await doc.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /baseColor|emissive/, resize: [+colour, +colour], quality: 86 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /normal/, resize: [+normal, +normal], quality: 88 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(dst, doc);
const mb = (f) => (statSync(f).size / 1048576).toFixed(2) + ' MB';
console.log(`${src} ${mb(src)} -> ${dst} ${mb(dst)}  triangles ${before} -> ${after}`);

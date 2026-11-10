import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const sem = new Set();
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const s of p.listSemantics()) sem.add(s);
  console.log(f.split('/').pop(), [...sem].join(','));
}

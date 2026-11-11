// Turn a generated character so that it faces +Z (what the auto-rigger expects). Shape untouched: a 90 degree turn only.
//   node tools/face-forward.mjs <in.glb> <out.glb>
// Generated characters come out facing +X or -X as often as +Z. Rigged that way, the arms are taken for front and back
// and the skin tears. The side the toes point to is the front.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [src, dst] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
// Some generators stand the model up with a node rotation (Z-up mesh under a 90 degree node). Bake every mesh node's
// rotation into its vertices first, so the vertex data itself is Y-up and what follows (and the rigger) sees it upright.
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  const [qx, qy, qz, qw] = node.getRotation();
  if (!mesh || Math.abs(qw) > 0.9999) continue;
  const rot = (v) => {
    // v' = q v q*
    const [x, y, z] = v;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
  };
  for (const p of mesh.listPrimitives()) {
    for (const name of ['POSITION', 'NORMAL', 'TANGENT']) {
      const a = p.getAttribute(name);
      if (!a) continue;
      for (let i = 0, v = [0, 0, 0, 0]; i < a.getCount(); i++) {
        a.getElement(i, v);
        const r = rot(v);
        a.setElement(i, name === 'TANGENT' ? [r[0], r[1], r[2], v[3]] : r);
      }
    }
  }
  node.setRotation([0, 0, 0, 1]);
  console.log('baked the node rotation into the vertices');
}
const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const p of prims) {
  const a = p.getAttribute('POSITION');
  for (let i = 0, v = [0, 0, 0]; i < a.getCount(); i++) {
    a.getElement(i, v);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v[k]); max[k] = Math.max(max[k], v[k]); }
  }
}
const h = max[1] - min[1];
// Depth axis = the thinner horizontal one (the arms of an A-pose span the other)
const depth = max[0] - min[0] < max[2] - min[2] ? 0 : 2;
let feet = 0, nf = 0, all = 0, na = 0;
for (const p of prims) {
  const a = p.getAttribute('POSITION');
  for (let i = 0, v = [0, 0, 0]; i < a.getCount(); i++) {
    a.getElement(i, v);
    all += v[depth]; na++;
    if (v[1] < min[1] + h * 0.05) { feet += v[depth]; nf++; }
  }
}
const sign = feet / nf > all / na ? 1 : -1;
// Map the front (sign * depth axis) onto +Z
const turn = depth === 2 ? (sign > 0 ? (v) => v : (v) => [-v[0], v[1], -v[2]]) : (sign > 0 ? (v) => [-v[2], v[1], v[0]] : (v) => [v[2], v[1], -v[0]]);
for (const p of prims) {
  for (const name of ['POSITION', 'NORMAL', 'TANGENT']) {
    const a = p.getAttribute(name);
    if (!a) continue;
    for (let i = 0, v = [0, 0, 0, 0]; i < a.getCount(); i++) {
      a.getElement(i, v);
      const r = turn(v);
      a.setElement(i, name === 'TANGENT' ? [r[0], r[1], r[2], v[3]] : r);
    }
  }
}
await io.write(dst, doc);
console.log(`front was ${sign > 0 ? '+' : '-'}${'XYZ'[depth]} (toes ${((feet / nf - all / na) * 100).toFixed(1)} cm ahead of the body centre at unit scale) -> +Z, ${dst}`);

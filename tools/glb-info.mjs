// GLB 요약 출력: node tools/glb-info.mjs <file.glb> [...]
// 메시/머티리얼/스킨/본 이름/애니메이션/텍스처 크기 확인용 (에셋 파이프라인 검증)
import { readFileSync, statSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'glTF') {
    console.log(`${file}: not a GLB (magic=${magic})`);
    continue;
  }
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const tris = (json.meshes ?? []).reduce((acc, m) => acc + m.primitives.reduce((a, p) => {
    const idx = p.indices != null ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count;
    return a + idx / 3;
  }, 0), 0);
  const bones = json.skins?.[0]?.joints?.map((j) => json.nodes[j].name) ?? [];
  console.log(`\n== ${file} (${(statSync(file).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`generator: ${json.asset?.generator ?? '?'}`);
  console.log(`meshes: ${json.meshes?.length ?? 0}, triangles: ${Math.round(tris)}, materials: ${json.materials?.length ?? 0}, images: ${json.images?.length ?? 0}`);
  console.log(`skins: ${json.skins?.length ?? 0}, joints: ${bones.length}`);
  if (bones.length) console.log(`bones: ${bones.slice(0, 12).join(', ')}${bones.length > 12 ? ', …' : ''}`);
  const anims = (json.animations ?? []).map((a) => {
    const maxT = Math.max(...a.samplers.map((s) => json.accessors[s.input].max?.[0] ?? 0));
    return `${a.name ?? '(unnamed)'} ${maxT.toFixed(2)}s ch=${a.channels.length}`;
  });
  console.log(`animations: ${anims.length ? anims.join(' | ') : 'none'}`);
  const skinned = (json.nodes ?? []).filter((n) => n.skin != null).map((n) => n.name);
  if (skinned.length) console.log(`skinned nodes: ${skinned.join(', ')}`);
  const extUsed = json.extensionsUsed ?? [];
  if (extUsed.length) console.log(`extensions: ${extUsed.join(', ')}`);
}

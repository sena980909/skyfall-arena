import { Box3, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';

/**
 * 맵 소품: 힉스필드에서 받은 GLB를 그대로 쓴다(Blender를 거치지 않는다). 여기서 하는 일은 세 가지뿐이다.
 *  1. 방향: 긴 쪽이 X가 되게 90° 단위로 돌린다(탈출선은 기수가 +Z, 계단은 +X로 내려가게).
 *  2. 크기: 충돌 상자(size = X 길이, Y 높이, Z 깊이)에 축마다 맞춘다. uniform이면 높이만 맞추고 비율은 그대로 둔다.
 *  3. 원점: 바닥 한가운데(계단은 맨 위 단의 가장자리 가운데).
 * 모양과 텍스처는 받은 그대로다. 파일은 tools/pack-generated.mjs로 용량만 줄여 public/assets/models/kit/에 둔다.
 */
interface KitSpec {
  size: [number, number, number];
  uniform?: boolean;
  /** 겉그림에서 밝고 진한 색(표시등·화면·경고등)을 빛나게 하는 세기 */
  glow?: number;
  /** 방향을 정하는 방법: 기본은 '긴 쪽을 X로' */
  face?: 'nose' | 'stairs';
  /** 자동으로 정한 방향에 더 돌릴 각(라디안). 앞뒤가 뒤집혀 나온 모델에 쓴다 */
  yaw?: number;
  metal?: number;
}

export const KIT_SPECS: Record<string, KitSpec> = {
  container: { size: [6, 2.5, 2.5] },
  crate: { size: [2, 1, 2] },
  barrier: { size: [6, 1.1, 0.6] },
  wall: { size: [8, 6, 1], glow: 1.6 },
  rack: { size: [4.5, 3.0, 1.2], glow: 2.2, metal: 0.45 },
  desk: { size: [14 / 3, 1.0, 1.2], glow: 2.0, metal: 0.4 },
  door: { size: [3, 4.7, 0.5], glow: 2.0 },
  pillar: { size: [1, 3.6, 1], glow: 1.5 },
  rail: { size: [12, 1, 0.3] },
  deck: { size: [12, 0.4, 12] },
  tower: { size: [10, 40, 10], glow: 2.5 },
  // 세 단짜리 계단 한 토막(단 높이 0.45, 디딤 0.7). 긴 계단은 이 토막을 이어 놓는다
  steps: { size: [2.1, 1.35, 4], face: 'stairs' },
  console: { size: [0, 2.0, 0], uniform: true, glow: 1.5 },
  lamp: { size: [0, 2.4, 0], uniform: true, glow: 3.0 },
  ship: { size: [0, 4.2, 0], uniform: true, glow: 2.0, face: 'nose' },
};

/** 모듈 이름 → 파일 이름(public/assets/models/kit/<파일>.glb) */
export const KIT_FILES = Object.keys(KIT_SPECS);

function points(model: Object3D): Vector3[] {
  model.updateMatrixWorld(true);
  const out: Vector3[] = [];
  model.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 12000));
    for (let i = 0; i < pos.count; i += step) out.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
  });
  return out;
}

/** 겉그림의 밝고 진한 부분만 빛나게 한다(생성 모델에는 발광 그림이 따로 없다) */
function addGlow(mat: MeshStandardMaterial, strength: number): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = { value: strength };
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_MAP
        {
          vec3 gc = sampledDiffuseColor.rgb;
          float gmx = max(gc.r, max(gc.g, gc.b));
          float gmn = min(gc.r, min(gc.g, gc.b));
          float gsat = (gmx - gmn) / max(gmx, 1e-4);
          totalEmissiveRadiance += gc * smoothstep(0.42, 0.62, gmx) * smoothstep(0.5, 0.65, gsat) * uGlow;
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `glow${strength}`;
}

/** 받은 모델 하나를 모듈로 만든다 */
function fit(name: string, model: Object3D, spec: KitSpec): Group {
  const holder = new Group();
  holder.name = `kit_${name}`;
  const wrap = new Group();
  holder.add(wrap);
  wrap.add(model);
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.setScalar(1);
  const measure = (): { box: Box3; dim: Vector3; pts: Vector3[] } => {
    const pts = points(model);
    const box = new Box3().setFromPoints(pts);
    return { box, dim: box.getSize(new Vector3()), pts };
  };
  let m = measure();
  if (spec.face === 'nose') {
    // 길이를 Z로 놓고, 가장 높은 곳(꼬리날개)이 뒤(-Z)에 오게 한다
    if (m.dim.x > m.dim.z) model.rotation.y = Math.PI / 2;
    m = measure();
    const top = m.pts.filter((p) => p.y > m.box.min.y + m.dim.y * 0.85);
    const tz = top.reduce((a, p) => a + p.z, 0) / Math.max(1, top.length);
    if (tz > (m.box.min.z + m.box.max.z) / 2) model.rotation.y += Math.PI;
  } else if (spec.face === 'stairs') {
    // 높이가 한쪽 끝에서 다른 쪽 끝으로 변하는 수평 축이 오르내리는 방향이다. 높은 끝이 -X에 오게 돌린다
    const rise = (axis: 'x' | 'z'): number => {
      const lo = m.box.min[axis];
      const len = m.dim[axis];
      const mean = (a: number, b: number): number => {
        const sel = m.pts.filter((p) => p[axis] >= lo + len * a && p[axis] <= lo + len * b);
        return sel.reduce((s, p) => s + p.y, 0) / Math.max(1, sel.length);
      };
      return mean(0.75, 1) - mean(0, 0.25);
    };
    const rx = rise('x');
    const rz = rise('z');
    if (Math.abs(rz) > Math.abs(rx)) model.rotation.y = rz > 0 ? -Math.PI / 2 : Math.PI / 2;
    else if (rx > 0) model.rotation.y = Math.PI;
  } else if (!spec.uniform && Math.abs(spec.size[0] - spec.size[2]) > 1e-3 && (m.dim.z > m.dim.x) !== (spec.size[2] > spec.size[0])) {
    model.rotation.y = Math.PI / 2;
  }
  if (spec.yaw) model.rotation.y += spec.yaw;
  m = measure();
  const k = spec.uniform
    ? new Vector3().setScalar(spec.size[1] / m.dim.y)
    : new Vector3(spec.size[0] / m.dim.x, spec.size[1] / m.dim.y, spec.size[2] / m.dim.z);
  const c = m.box.getCenter(new Vector3());
  model.position.set(spec.face === 'stairs' ? -m.box.min.x : -c.x, -m.box.min.y, -c.z);
  wrap.scale.copy(k);
  model.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const sm = mat as MeshStandardMaterial;
      sm.name = `kit_${name}_gen`;
      // 생성된 거칠기·금속 지도는 거울에 가깝다 → 싣지 않고 칠한 금속의 값으로 둔다
      sm.metalnessMap = null;
      sm.roughnessMap = null;
      sm.aoMap = null;
      sm.metalness = spec.metal ?? 0.3;
      sm.roughness = 0.6;
      if (sm.map) sm.map.anisotropy = 8;
      if (spec.glow) addGlow(sm, spec.glow);
      sm.needsUpdate = true;
    }
  });
  const stretch = Math.max(k.x, k.y, k.z) / Math.min(k.x, k.y, k.z);
  let tris = 0;
  model.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) tris += (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;
  });
  console.info(`[Kit] ${name}: 삼각형 ${tris}, 늘린 비율 ${stretch.toFixed(2)}`);
  return holder;
}

/** 받은 모델들로 모듈 묶음을 만든다. GreyboxMap.applyKit과 Mission이 이름(kit_...)으로 꺼내 복제해 쓴다 */
export function buildKit(models: Record<string, Object3D | null>): Group {
  const kit = new Group();
  kit.name = 'kit';
  for (const [name, spec] of Object.entries(KIT_SPECS)) {
    const model = models[name];
    if (model) kit.add(fit(name, model, spec));
  }
  const alias = (from: string, to: string): void => {
    const src = kit.getObjectByName(`kit_${from}`);
    if (!src) return;
    const copy = src.clone(true);
    copy.name = `kit_${to}`;
    kit.add(copy);
  };
  // 컨테이너는 모델 하나를 네 이름으로 쓴다(색 변형은 GreyboxMap이 낸다)
  for (const t of 'abcd') alias('container', `container_${t}`);
  // 높은 상자 = 상자 둘을 쌓은 것(위 상자는 90° 돌려 같은 면이 겹쳐 보이지 않게)
  const crate = kit.getObjectByName('kit_crate');
  if (crate) {
    const tall = new Group();
    tall.name = 'kit_crate_tall';
    const top = crate.clone(true);
    top.position.y = 1;
    top.rotation.y = Math.PI / 2;
    tall.add(crate.clone(true), top);
    kit.add(tall);
  }
  kit.updateMatrixWorld(true);
  return kit;
}

/** 모듈의 크기(확인용) */
export function kitSize(kit: Group, name: string): Vector3 | null {
  const o = kit.getObjectByName(`kit_${name}`);
  if (!o) return null;
  o.updateMatrixWorld(true);
  const inv = new Matrix4().copy(o.matrixWorld).invert();
  return new Box3().setFromPoints(points(o).map((p) => p.applyMatrix4(inv))).getSize(new Vector3());
}

import { Box3, Euler, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { addCyanGlow } from '@/entities/PlayerBody';

/**
 * 1인칭에 쓰는 힉스필드 모델 셋. 총(탄창 뺀 것)과 탄창은 받은 그대로의 덩어리이고,
 * 몸은 힉스필드에서 리깅한 주인공 모델이다(뼈대가 있다). 몸에서는 두 팔만 화면에 들어온다.
 */
export interface FpDirectParts {
  gun: Group;
  mag: Group;
  body: Group;
}

type V3 = [number, number, number];
type Pose = { pos: V3; rot: V3 };
/** 손의 자세: 손바닥 한가운데가 놓일 자리, 손가락이 뻗는 쪽, 손바닥이 보는 쪽 */
type Grip = { pos: V3; fingers: V3; palm: V3 };

/**
 * 1인칭 총과 팔의 배치 수치. 좌표는 카메라 공간(+X 오른쪽, +Y 위, -Z 앞), 길이는 미터, 각도는 라디안.
 * '총 공간'은 총 상자의 중심이 원점이고 총구가 -Z를 본다. 손의 자세는 손바닥이 놓일 자리와 손가락·손바닥의 방향이다.
 * 모델을 다시 받으면 이 수치만 고친다(개발 중에는 콘솔의 __fp.cfg를 바꾸고 __fp.layout()을 부르면 바로 보인다).
 */
export const FP_DIRECT = {
  /** 총 길이, 총 상자 중심의 자리, 총의 기울기. 개머리판 끝은 카메라 옆(화면 밖)에 온다 */
  gunLength: 0.62,
  gunPos: [0.16, -0.165, -0.5] as V3,
  gunRot: [0, 0.12, 0.04] as V3,
  /** 탄창: 높이, 모델을 세우는 회전, 총 공간에서 꽂혀 있는 자세 */
  magHeight: 0.15,
  magFix: [0, 0, 0] as V3,
  mag: { pos: [0, -0.09, 0.18], rot: [0, 0, 0] } as Pose,
  /** 몸: 팔 길이(어깨에서 손목까지, 뼈를 따라), 두 어깨 관절의 한가운데가 놓일 자리, 몸을 튼 각도(왼 어깨가 앞으로 나온다) */
  armLength: 0.485,
  shoulders: [0, -0.3, -0.12] as V3,
  bodyYaw: 0.4,
  /** 손의 자세(총 공간): 오른손은 손잡이, 왼손은 총열덮개 아래, 재장전 때 왼손은 탄창 */
  handR: { pos: [0.005, -0.085, 0.09], fingers: [0, -0.1, -1], palm: [-1, 0, 0.1] } as Grip,
  handL: { pos: [0, -0.07, -0.18], fingers: [0.8, 0.1, -0.6], palm: [-0.1, 1, 0] } as Grip,
  handMag: { pos: [-0.02, -0.12, 0.18], fingers: [-0.15, 0.5, -0.85], palm: [0.95, 0.3, 0] } as Grip,
  /** 탄창을 뽑아 내린 거리(총 공간)와, 왼손이 화면 밖으로 내려간 자세(카메라 공간) */
  magPull: [-0.02, -0.17, 0.02] as V3,
  handAway: { pos: [-0.12, -0.6, -0.2], fingers: [0, 0.4, -0.9], palm: [0.9, 0.3, 0.2] } as Grip,
  /**
   * 손바닥이 보는 쪽(손 뼈 기준 좌표). 모델에서 잰 값이다: 손등과 손가락 등에만 파란 판이 있어서, 손 정점 가운데
   * 겉그림이 파란 것들의 한가운데에서 검은 것들의 한가운데를 뺀 방향이 손등 쪽이고 그 반대가 손바닥이다.
   * 몸 모델을 다시 받으면 다시 재야 한다.
   */
  palmL: [0.5, 0.17, -0.85] as V3,
  palmR: [-0.78, -0.05, -0.62] as V3,
  /** 팔꿈치가 향하는 쪽(카메라 공간) */
  elbowR: [0.55, -0.8, 0.25] as V3,
  elbowL: [-0.7, -0.6, 0.3] as V3,
  /** 손목을 돌린 만큼 전완도 따라 도는 비율 */
  twistShare: 0.6,
  /**
   * 조준기의 홀로그램 창(총 공간). 이미지→3D는 비치는 것을 만들지 못해서, 받은 모델에서는 창이 희끄무레한 덩어리다.
   * 그 덩어리(상자 안의 밝은 면)를 어두운 유리로 칠하고, 쏘는 사람 눈에서 본 방향으로 빛나는 조준점을 그려 넣는다.
   * 상자는 모델에서 잰 값이다(조준기 자리의 밝은 정점들이 차지한 범위). 총 모델을 다시 받으면 다시 재야 한다.
   * shift = 조준점을 창 한가운데로 옮기는 양(눈에서 본 오른쪽, 위), ring = 조준점 고리의 반지름
   */
  sight: { halfX: 0.0225, y: [0.094, 0.14], z: [0.028, 0.115], centre: [0, 0.113, 0.065], shift: [-0.006, 0.002], ring: 0.0065 } as {
    halfX: number; y: [number, number]; z: [number, number]; centre: V3; shift: [number, number]; ring: number;
  },
  /** 재장전 때 총이 기우는 만큼(이동, 회전): 총구를 조금 들고 밑면을 왼쪽으로 돌려 탄창 쪽이 화면에 보이게 한다 */
  cant: { pos: [-0.03, 0.01, 0], rot: [0.1, 0.1, -0.8] } as Pose,
};

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

interface Arm {
  upper: Object3D;
  fore: Object3D;
  hand: Object3D;
  /** 처음 자세(A자세)의 회전: 매 스텝 여기서부터 다시 푼다 */
  rest: [Quaternion, Quaternion, Quaternion];
  /** 손 뼈 기준: 손가락이 뻗는 쪽, 손바닥이 보는 쪽, 손목에서 손바닥 한가운데까지의 거리 */
  fingers: Vector3;
  palm: Vector3;
  reach: number;
  /** 손 뼈 기준 축을 표준 축(X = 손가락, Z = 손바닥)으로 돌리는 회전의 역 */
  frame: Quaternion;
}

/** 두 방향으로 회전을 만든다: X축이 a를, Z축이 (a에 수직으로 편) b를 본다 */
function frameOf(a: Vector3, b: Vector3, out: Quaternion): Quaternion {
  const x = a.clone().normalize();
  const z = b.clone().addScaledVector(x, -b.dot(x));
  if (z.lengthSq() < 1e-10) z.set(0, 1, 0).addScaledVector(x, -x.y);
  z.normalize();
  const y = new Vector3().crossVectors(z, x);
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/**
 * 1인칭 총과 두 팔. 모델은 힉스필드에서 받은 그대로 쓰고(Blender를 거치지 않는다), 자리와 움직임은 전부 여기서 정한다.
 *
 *  root(카메라 원점)
 *   ├ gunRig(총의 자리. 재장전 때 기울어진다)
 *   │   ├ 총 모델, 탄창, 총구 지점
 *   └ body(리깅된 몸. 머리와 다리는 접어 두고, 두 팔을 뼈대로 움직여 손목을 총에 가져다 댄다)
 *
 * 손은 총에 구워 넣지 않았다: 어깨에서 팔꿈치, 손목까지 뼈대(2본 IK)가 풀어서 오른손은 손잡이로,
 * 왼손은 총열덮개로 간다. 재장전 때는 왼손이 탄창으로 가서 뽑아 내렸다가 새 탄창을 꽂는다.
 * 손가락 뼈는 없다(힉스필드 리깅에 없다): 손 모양은 모델에 빚어진 그대로다.
 */
export class FpDirect {
  readonly root = new Group();
  readonly muzzle = new Object3D();
  readonly cfg = FP_DIRECT;
  private readonly gunRig = new Group();
  private readonly gunNode = new Group();
  private readonly magNode = new Group();
  private readonly magInner = new Group();
  private readonly bodyNode = new Group();
  private readonly body: Group;
  private readonly armL: Arm | null;
  private readonly armR: Arm | null;
  private cant = 0;
  private seat = 0;
  private handReady = false;
  private readonly handPos = new Vector3();
  private readonly handQuat = new Quaternion();
  private readonly reachOf = new Map<Arm, number>();
  /** 조준기 유리 셰이더가 쓰는 값: 총 모델 좌표 → 총 공간, 조준점의 중심과 눈에서 본 오른쪽·위 */
  private readonly sightU = {
    uToGun: { value: new Matrix4() },
    uHoloC: { value: new Vector3() },
    uHoloU: { value: new Vector3(1, 0, 0) },
    uHoloV: { value: new Vector3(0, 1, 0) },
  };
  private readonly m1 = new Matrix4();
  private readonly m2 = new Matrix4();
  private readonly m3 = new Matrix4();
  private readonly p1 = new Vector3();
  private readonly p2 = new Vector3();
  private readonly q1 = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly q3 = new Quaternion();
  private readonly s1 = new Vector3();
  private readonly e1 = new Euler();
  private readonly v = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];

  constructor(private readonly parts: FpDirectParts, layer: number) {
    this.body = skeletonClone(parts.body) as Group;
    this.gunNode.add(parts.gun);
    this.magInner.add(parts.mag);
    this.magNode.add(this.magInner);
    this.gunRig.add(this.gunNode, this.magNode, this.muzzle);
    this.bodyNode.add(this.body);
    this.root.add(this.gunRig, this.bodyNode);
    this.root.traverse((o) => {
      o.layers.set(layer);
      o.frustumCulled = false;
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.receiveShadow = false;
      const skinned = (m as SkinnedMesh).isSkinnedMesh;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((orig) => {
        // 몸의 재질은 3인칭 몸과 나눠 쓰므로 복제해서 고친다
        const sm = (skinned ? orig.clone() : orig) as MeshStandardMaterial;
        // 생성된 거칠기·금속 지도는 거울에 가깝다(가까이서 젖은 크롬처럼 보인다). 칠한 금속의 값으로 두고 노멀맵만 쓴다
        sm.metalnessMap = null;
        sm.roughnessMap = null;
        sm.aoMap = null;
        sm.metalness = 0.3;
        sm.roughness = 0.55;
        sm.envMapIntensity = 0.3;
        if (sm.normalMap) sm.normalScale.set(0.8, 0.8);
        if (sm.map) sm.map.anisotropy = 8;
        // 겉그림의 청록 불빛(조준기 홀로그램, 띠)이 빛나게 한다
        addCyanGlow(sm, 1.2);
        sm.needsUpdate = true;
        return sm;
      });
      m.material = mats.length === 1 ? mats[0] : mats;
    });
    this.gunNode.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) this.addSightGlass(mat as MeshStandardMaterial);
    });
    const bone = (n: string): Object3D | null => this.body.getObjectByName(n) ?? null;
    const arm = (side: string): Arm | null => {
      const upper = bone(`${side}Arm`);
      const fore = bone(`${side}ForeArm`);
      const hand = bone(`${side}Hand`);
      if (!upper || !fore || !hand) return null;
      const rest: [Quaternion, Quaternion, Quaternion] = [upper.quaternion.clone(), fore.quaternion.clone(), hand.quaternion.clone()];
      return { upper, fore, hand, rest, fingers: new Vector3(0, 1, 0), palm: new Vector3(0, 0, 1), reach: 0.08, frame: new Quaternion() };
    };
    this.armL = arm('Left');
    this.armR = arm('Right');
    this.findHandAxes();
    // 머리와 다리는 화면에 들어올 일이 없다. 한 점으로 접어 둔다(머리는 카메라 자리에 있어서 그대로 두면 화면을 가린다)
    for (const n of ['neck', 'LeftUpLeg', 'RightUpLeg']) bone(n)?.scale.setScalar(1e-4);
    this.fitGun();
    this.layout();
    this.update(0, -1);
  }

  /**
   * 총의 재질: 청록 불빛을 빛나게 하고(addCyanGlow와 같은 식), 조준기 상자 안의 밝은 면은 어두운 유리로 바꿔
   * 조준점(고리, 가운데 점, 눈금 넷)을 그린다. 조준점은 눈에서 본 방향으로 비춘 것이라, 면이 꺾여도 한 모양으로 보인다.
   */
  private addSightGlass(mat: MeshStandardMaterial): void {
    const c = this.cfg.sight;
    const f = (v: number): string => v.toFixed(5);
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.sightU, { uGlow: { value: 1.2 } });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 uToGun;\nvarying vec3 vGun;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGun = (uToGun * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uGlow;\nuniform vec3 uHoloC;\nuniform vec3 uHoloU;\nuniform vec3 uHoloV;\nvarying vec3 vGun;\nfloat holo = 0.0;')
        .replace('#include <map_fragment>', `#include <map_fragment>
        #ifdef USE_MAP
        if (abs(vGun.x) < ${f(c.halfX)} && vGun.y > ${f(c.y[0])} && vGun.y < ${f(c.y[1])} && vGun.z > ${f(c.z[0])} && vGun.z < ${f(c.z[1])}) {
          holo = smoothstep(0.14, 0.26, sampledDiffuseColor.r);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.06, 0.085), holo);
        }
        #endif`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_MAP
        {
          vec3 gc = sampledDiffuseColor.rgb;
          float gcy = min(gc.g, gc.b);
          totalEmissiveRadiance += gc * smoothstep(0.5, 0.75, gcy) * smoothstep(0.12, 0.3, gcy - gc.r) * uGlow * (1.0 - holo);
        }
        if (holo > 0.0) {
          vec3 hd = vGun - uHoloC;
          float hu = dot(hd, uHoloU);
          float hv = dot(hd, uHoloV);
          float hr = length(vec2(hu, hv));
          float ring = smoothstep(0.0011, 0.0003, abs(hr - ${f(c.ring)}));
          float core = smoothstep(0.0016, 0.0008, hr);
          float t0 = ${f(c.ring + 0.0015)};
          float t1 = ${f(c.ring + 0.006)};
          float tick = smoothstep(0.0008, 0.0002, abs(hu)) * step(t0, abs(hv)) * step(abs(hv), t1)
            + smoothstep(0.0008, 0.0002, abs(hv)) * step(t0, abs(hu)) * step(abs(hu), t1);
          totalEmissiveRadiance += vec3(0.2, 0.9, 1.0) * (clamp(max(max(ring, core), tick), 0.0, 1.0) * 2.4 + 0.05) * holo;
        }
        #endif`);
    };
    mat.customProgramCacheKey = () => 'fpSightGlass';
    mat.needsUpdate = true;
  }

  /** 조준기 유리 셰이더의 값: 총 모델을 총 공간으로 옮기는 행렬, 눈(카메라 원점)에서 본 조준점의 자리 */
  private placeSight(): void {
    const c = this.cfg.sight;
    this.root.updateMatrixWorld(true);
    let mesh: Object3D | null = null;
    this.gunNode.traverse((o) => {
      if ((o as Mesh).isMesh && !mesh) mesh = o;
    });
    const gm = mesh as Object3D | null;
    if (!gm) return;
    const inv = this.m1.copy(this.gunRig.matrixWorld).invert();
    this.sightU.uToGun.value.multiplyMatrices(inv, gm.matrixWorld);
    const centre = this.v[0].set(...c.centre);
    const eye = this.root.getWorldPosition(this.v[1]).applyMatrix4(inv);
    const n = this.v[2].copy(eye).sub(centre).normalize();
    const u = this.sightU.uHoloU.value.set(0, 1, 0).cross(n).normalize();
    const w = this.sightU.uHoloV.value.crossVectors(n, u);
    this.sightU.uHoloC.value.copy(centre).addScaledVector(u, c.shift[0]).addScaledVector(w, c.shift[1]);
  }

  /** 모델의 정점(모델의 부모 기준 좌표)을 돌려준다 */
  private static points(model: Object3D): Vector3[] {
    model.updateMatrixWorld(true);
    const inv = new Matrix4().copy(model.parent ? model.parent.matrixWorld : new Matrix4()).invert();
    const out: Vector3[] = [];
    model.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.attributes.position;
      const mw = new Matrix4().multiplyMatrices(inv, m.matrixWorld);
      const step = Math.max(1, Math.floor(pos.count / 20000));
      for (let i = 0; i < pos.count; i += step) out.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(mw));
    });
    return out;
  }

  /** 모델을 상자 중심이 원점에 오게 옮기고, 가장 긴 변이 size가 되게 맞춘다 */
  private static centre(model: Object3D, size: number): void {
    model.position.set(0, 0, 0);
    model.scale.setScalar(1);
    const box = new Box3().setFromPoints(FpDirect.points(model));
    const dim = box.getSize(new Vector3());
    const k = size / Math.max(dim.x, dim.y, dim.z);
    const c = box.getCenter(new Vector3());
    model.scale.setScalar(k);
    model.position.copy(c).multiplyScalar(-k);
  }

  /**
   * 총을 세운다: 위는 모델의 +Y 그대로(생성 모델은 그림대로 서서 나온다), 가장 긴 수평 축을 앞뒤로 놓고,
   * 양 끝 중 가는 쪽(총열)이 앞(-Z)을 보게 돌린다. 모델을 다시 받아도 손댈 것이 없다.
   */
  private fitGun(): void {
    const g = this.parts.gun;
    g.rotation.set(0, 0, 0);
    let pts = FpDirect.points(g);
    let box = new Box3().setFromPoints(pts);
    let dim = box.getSize(new Vector3());
    if (dim.x > dim.z) g.rotation.y = Math.PI / 2;
    pts = FpDirect.points(g);
    box = new Box3().setFromPoints(pts);
    dim = box.getSize(new Vector3());
    // 양 끝 10% 구간의 높이: 낮은 쪽이 총열
    const span = (z0: number, z1: number): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pts) {
        if (p.z < z0 || p.z > z1) continue;
        lo = Math.min(lo, p.y);
        hi = Math.max(hi, p.y);
      }
      return hi - lo;
    };
    const front = span(box.min.z, box.min.z + dim.z * 0.1);
    const back = span(box.max.z - dim.z * 0.1, box.max.z);
    if (front > back) g.rotation.y += Math.PI;
    FpDirect.centre(g, this.cfg.gunLength);
    const fitted = FpDirect.points(g);
    const fb = new Box3().setFromPoints(fitted);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const p of fitted) {
      if (p.z > fb.min.z + 0.012) continue;
      sx += p.x;
      sy += p.y;
      n++;
    }
    this.muzzle.position.set(n ? sx / n : 0, n ? sy / n : 0, fb.min.z);
  }

  /**
   * 손 뼈 기준으로 손이 어떻게 놓여 있는지 정한다: 손가락이 뻗는 쪽은 모델에서 찾고(손목에서 손 정점들의 한가운데로),
   * 손바닥이 보는 쪽은 모델에서 재어 둔 값(cfg.palmL, cfg.palmR)을 쓴다.
   */
  private findHandAxes(): void {
    let mesh: SkinnedMesh | null = null;
    this.body.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as SkinnedMesh;
    });
    const sk = mesh as SkinnedMesh | null;
    if (!sk) return;
    const pos = sk.geometry.attributes.position;
    const si = sk.geometry.attributes.skinIndex;
    const sw = sk.geometry.attributes.skinWeight;
    const p = new Vector3();
    for (const [side, a] of [[0, this.armL], [1, this.armR]] as [number, Arm | null][]) {
      if (!a) continue;
      const bi = sk.skeleton.bones.indexOf(a.hand as never);
      if (bi < 0) continue;
      const toBone = new Matrix4().multiplyMatrices(sk.skeleton.boneInverses[bi], sk.bindMatrix);
      const pts: Vector3[] = [];
      for (let i = 0; i < pos.count; i++) {
        let wgt = 0;
        for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) wgt += sw.getComponent(i, k);
        if (wgt < 0.5) continue;
        pts.push(p.fromBufferAttribute(pos, i).applyMatrix4(toBone).clone());
      }
      if (pts.length < 8) continue;
      const c = new Vector3();
      for (const q of pts) c.add(q);
      c.multiplyScalar(1 / pts.length);
      const f = c.clone().normalize();
      const n = new Vector3(...(side === 0 ? this.cfg.palmL : this.cfg.palmR));
      n.addScaledVector(f, -n.dot(f)).normalize();
      a.fingers.copy(f);
      a.palm.copy(n);
      a.reach = c.length();
      frameOf(f, n, a.frame).invert();
    }
  }

  /** 손의 자세(자리, 손가락 방향, 손바닥 방향)를 손목 뼈의 자세(행렬)로 바꾼다 */
  private gripMatrix(g: Grip, arm: Arm | null, reach: number, out: Matrix4): Matrix4 {
    const f = this.v[0].set(...g.fingers).normalize();
    frameOf(f, this.v[1].set(...g.palm), this.q2);
    if (arm) this.q2.multiply(arm.frame);
    return out.compose(this.p2.set(...g.pos).addScaledVector(f, -reach), this.q2, this.s1.set(1, 1, 1));
  }

  /** 배치 수치(cfg)를 모델에 적용한다 */
  layout(): void {
    const c = this.cfg;
    // 탄창: 세우는 회전을 먹인 뒤 높이에 맞춘다
    this.parts.mag.rotation.set(...c.magFix);
    this.parts.mag.position.set(0, 0, 0);
    this.parts.mag.scale.setScalar(1);
    const mdim = new Box3().setFromPoints(FpDirect.points(this.parts.mag)).getSize(new Vector3());
    FpDirect.centre(this.parts.mag, c.magHeight * (Math.max(mdim.x, mdim.y, mdim.z) / mdim.y));

    // 몸: 팔 길이에 맞추고, 앞(-Z)을 보게 돌린 뒤 두 어깨의 한가운데를 정한 자리에 놓는다
    for (const a of [this.armL, this.armR]) {
      if (!a) continue;
      a.upper.quaternion.copy(a.rest[0]);
      a.fore.quaternion.copy(a.rest[1]);
      a.hand.quaternion.copy(a.rest[2]);
    }
    const node = this.bodyNode;
    node.position.set(0, 0, 0);
    node.rotation.set(0, Math.PI + c.bodyYaw, 0);
    node.scale.setScalar(1);
    this.root.updateMatrixWorld(true);
    const unit0 = this.root.getWorldScale(this.v[2]).x || 1;
    let len = 0;
    let arms = 0;
    for (const a of [this.armL, this.armR]) {
      if (!a) continue;
      const elbow = a.fore.getWorldPosition(this.v[1]);
      len += a.upper.getWorldPosition(this.v[0]).distanceTo(elbow) + elbow.distanceTo(a.hand.getWorldPosition(this.v[3]));
      arms++;
    }
    if (arms && len > 0) node.scale.setScalar(c.armLength / (len / arms / unit0));
    this.root.updateMatrixWorld(true);
    if (this.armL && this.armR) {
      const mid = this.root.worldToLocal(this.armL.upper.getWorldPosition(this.v[0]))
        .add(this.root.worldToLocal(this.armR.upper.getWorldPosition(this.v[1])))
        .multiplyScalar(0.5);
      node.position.set(c.shoulders[0] - mid.x, c.shoulders[1] - mid.y, c.shoulders[2] - mid.z);
    }
    // 손목에서 손바닥까지의 거리(미터): 뼈 기준 길이에 몸의 배율을 곱한다
    this.root.updateMatrixWorld(true);
    const unit = this.root.getWorldScale(this.v[2]).x || 1;
    for (const a of [this.armL, this.armR]) {
      if (!a) continue;
      a.reach = Math.abs(a.reach);
      this.reachOf.set(a, (a.reach * a.hand.getWorldScale(this.v[3]).x) / unit);
    }
    this.handReady = false;
    this.update(0, -1);
    this.placeSight();
  }

  private poseMatrix(p: Pose, out: Matrix4): Matrix4 {
    return out.compose(this.p2.set(...p.pos), this.q2.setFromEuler(this.e1.set(p.rot[0], p.rot[1], p.rot[2], 'YXZ')), this.s1.set(1, 1, 1));
  }

  /**
   * 매 스텝. reload = 재장전 진행도 0..1, 재장전 중이 아니면 음수.
   * 재장전: 총을 안쪽으로 기울인다 → 왼손이 탄창으로 간다 → 뽑아 화면 아래로 내린다 → 새 탄창을 들고 올라온다 →
   * 밀어 넣는다(총이 살짝 튄다) → 왼손이 총열덮개로 돌아가고 총이 선다. 소리 신호(0.10, 0.66, 0.82)와 맞춰 두었다.
   */
  update(dt: number, reload: number): void {
    const c = this.cfg;
    const t = reload;
    const on = t >= 0;
    const tCant = on ? smooth(0.02, 0.12, t) * (1 - smooth(0.76, 0.93, t)) : 0;
    const tSeat = on ? smooth(0.64, 0.67, t) * (1 - smooth(0.67, 0.76, t)) : 0;
    // 목표를 바로 쓰지 않고 따라가게 한다: 재장전이 도중에 끊겨도 총이 한 프레임에 튀지 않는다
    this.cant += (tCant - this.cant) * Math.min(1, dt * 14 || 1);
    this.seat += (tSeat - this.seat) * Math.min(1, dt * 40 || 1);
    const k = this.cant;
    this.gunRig.position.set(c.gunPos[0] + k * c.cant.pos[0], c.gunPos[1] + k * c.cant.pos[1] + this.seat * 0.012, c.gunPos[2] + k * c.cant.pos[2]);
    this.gunRig.rotation.set(c.gunRot[0] + k * c.cant.rot[0], c.gunRot[1] + k * c.cant.rot[1], c.gunRot[2] + k * c.cant.rot[2]);
    this.gunRig.updateMatrix();

    // 왼손: 자세 넷(받침, 탄창, 뽑아 내림, 화면 밖)을 차례로 섞는다. 앞의 셋은 총 공간이라 총이 기울면 함께 간다
    const gm = this.gunRig.matrix;
    const mix = (target: Matrix4, w: number): void => {
      if (w <= 0) return;
      target.decompose(this.p2, this.q2, this.s1);
      this.p1.lerp(this.p2, w);
      this.q1.slerp(this.q2, w);
    };
    const aL = this.armL;
    const rL = aL ? this.reachOf.get(aL) ?? 0.08 : 0.08;
    const hold = this.m1.multiplyMatrices(gm, this.gripMatrix(c.handL, aL, rL, this.m2)).clone();
    hold.decompose(this.p1, this.q1, this.s1);
    const magGrip = this.gripMatrix(c.handMag, aL, rL, this.m2).clone();
    const atMag = this.m1.multiplyMatrices(gm, magGrip).clone();
    const pulled: Grip = { ...c.handMag, pos: [c.handMag.pos[0] + c.magPull[0], c.handMag.pos[1] + c.magPull[1], c.handMag.pos[2] + c.magPull[2]] };
    const out = this.m1.multiplyMatrices(gm, this.gripMatrix(pulled, aL, rL, this.m2)).clone();
    const away = this.gripMatrix(c.handAway, aL, rL, this.m2).clone();
    let carried = false;
    if (on) {
      mix(atMag, smooth(0.02, 0.1, t));
      mix(out, smooth(0.1, 0.2, t));
      mix(away, smooth(0.2, 0.33, t));
      mix(out, smooth(0.42, 0.55, t));
      mix(atMag, smooth(0.57, 0.665, t));
      mix(hold, smooth(0.72, 0.88, t));
      carried = t > 0.1 && t < 0.665;
    }
    if (!this.handReady) {
      this.handPos.copy(this.p1);
      this.handQuat.copy(this.q1);
      this.handReady = true;
    }
    const follow = Math.min(1, dt * 26 || 1);
    this.handPos.lerp(this.p1, follow);
    this.handQuat.slerp(this.q1, follow);

    // 탄창: 꽂혀 있거나, 손에 들려 있다(쥔 순간의 손과 탄창의 상대 자리를 그대로 지킨다)
    const rest = this.poseMatrix(c.mag, this.m2).clone();
    if (carried) {
      // 총 공간의 탄창 = inv(총) x 손 x inv(총 공간에서 탄창을 쥔 손) x 꽂힌 탄창
      const hand = this.m3.compose(this.handPos, this.handQuat, this.s1.set(1, 1, 1)).clone();
      this.m1.copy(gm).invert().multiply(hand).multiply(magGrip.invert()).multiply(rest);
      this.m1.decompose(this.magNode.position, this.magNode.quaternion, this.s1);
    } else rest.decompose(this.magNode.position, this.magNode.quaternion, this.s1);

    // 두 팔: 손목을 정한 자리와 방향으로 (카메라 공간의 자세를 월드로 옮겨서 푼다)
    this.root.updateWorldMatrix(true, true);
    const rw = this.root.matrixWorld;
    const rq = this.root.getWorldQuaternion(this.q3).clone();
    if (this.armR) {
      this.m1.multiplyMatrices(gm, this.gripMatrix(c.handR, this.armR, this.reachOf.get(this.armR) ?? 0.08, this.m2)).decompose(this.p1, this.q1, this.s1);
      this.solveArm(this.armR, this.p1.clone().applyMatrix4(rw), this.v[7].set(...c.elbowR).applyQuaternion(rq), rq.clone().multiply(this.q1));
    }
    if (this.armL) {
      this.solveArm(this.armL, this.p1.copy(this.handPos).applyMatrix4(rw), this.v[7].set(...c.elbowL).applyQuaternion(rq), rq.clone().multiply(this.handQuat));
    }
  }

  /**
   * 2본 IK. 손목을 target(월드)에, 팔꿈치를 pole 쪽에 두고, 손의 방향을 handQuat(월드)에 맞춘다.
   * 손목이 돈 만큼의 일부는 전완이 함께 돈다(실제 팔처럼 전완이 비틀린다).
   */
  private solveArm(arm: Arm, target: Vector3, pole: Vector3, handQuat: Quaternion): void {
    const [a, b, h, u, w, e, dir] = this.v;
    arm.upper.quaternion.copy(arm.rest[0]);
    arm.fore.quaternion.copy(arm.rest[1]);
    arm.hand.quaternion.copy(arm.rest[2]);
    arm.upper.updateWorldMatrix(true, true);
    arm.upper.getWorldPosition(a);
    arm.fore.getWorldPosition(b);
    arm.hand.getWorldPosition(h);
    const l1 = a.distanceTo(b);
    const l2 = b.distanceTo(h);
    if (l1 < 1e-5 || l2 < 1e-5) return;
    dir.copy(target).sub(a);
    const d = Math.min(l1 + l2 - 0.002, Math.max(Math.abs(l1 - l2) + 0.002, dir.length()));
    dir.normalize();
    // 팔꿈치: 어깨-손목 선에서 pole 쪽으로 벌어진 자리
    const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const r = Math.sqrt(Math.max(0, l1 * l1 - x * x));
    e.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (e.lengthSq() < 1e-8) e.set(0, -1, 0).addScaledVector(dir, dir.y);
    e.normalize().multiplyScalar(r).addScaledVector(dir, x).add(a);
    u.copy(b).sub(a).normalize();
    w.copy(e).sub(a).normalize();
    this.rotateWorld(arm.upper, this.q1.setFromUnitVectors(u, w));
    arm.upper.updateMatrixWorld(true);
    arm.fore.getWorldPosition(b);
    arm.hand.getWorldPosition(h);
    u.copy(h).sub(b).normalize();
    w.copy(a).addScaledVector(dir, d).sub(b).normalize();
    this.rotateWorld(arm.fore, this.q1.setFromUnitVectors(u, w));
    arm.fore.updateMatrixWorld(true);
    // 손목 회전 가운데 전완 축을 도는 성분을 전완에 나눠 준다
    arm.hand.getWorldQuaternion(this.q2);
    this.q1.copy(handQuat).multiply(this.q2.invert());
    const proj = w.x * this.q1.x + w.y * this.q1.y + w.z * this.q1.z;
    this.q2.set(w.x * proj, w.y * proj, w.z * proj, this.q1.w);
    if (this.q2.lengthSq() > 1e-10) {
      this.q2.normalize();
      this.q1.identity().slerp(this.q2, this.cfg.twistShare);
      this.rotateWorld(arm.fore, this.q1);
      arm.fore.updateMatrixWorld(true);
    }
    const parent = arm.hand.parent;
    if (parent) arm.hand.quaternion.copy(parent.getWorldQuaternion(this.q2).invert().multiply(handQuat));
    arm.hand.updateMatrixWorld(true);
  }

  /** 월드 회전 q를 본에 적용: L' = Wp⁻¹ · q · Wp · L */
  private rotateWorld(bone: Object3D, q: Quaternion): void {
    const wp = bone.parent ? bone.parent.getWorldQuaternion(new Quaternion()) : new Quaternion();
    const inv = wp.clone().invert();
    bone.quaternion.premultiply(inv.multiply(q).multiply(wp));
  }
}

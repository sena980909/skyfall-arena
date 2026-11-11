import { Box3, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';

/** 힉스필드에서 받은 1인칭 모델 하나: 두 팔이 총을 쥔 채로 한 덩어리다. 받은 그대로다(뼈대도 애니메이션도 없다) */
export interface FpDirectParts {
  held: Group;
}

type Pose = { pos: [number, number, number]; rot: [number, number, number] };

/**
 * 1인칭 총의 배치 수치. 좌표는 카메라 공간(+X 오른쪽, +Y 위, -Z 앞), 길이는 미터, 각도는 라디안(XYZ 순서).
 * 모델을 다시 받으면 이 수치만 고친다(개발 중에는 콘솔의 __fp.cfg를 바꾸고 __fp.layout()을 부르면 바로 보인다).
 */
export const FP_DIRECT = {
  /** 모델 전체(뒤쪽 어깨 끝에서 총구까지)의 앞뒤 길이 */
  length: 0.735,
  /**
   * 모델 상자 중심의 자리와 기울기. 총구를 화면 가운데 쪽으로 조금 돌리고 왼쪽을 낮췄다:
   * 왼손과 전완은 화면에 들어오고, 두 팔의 어깨 쪽 끝은 화면 아래로 나간다.
   */
  pos: [0.15, -0.205, -0.47] as [number, number, number],
  rot: [0, 0.1, 0.1] as [number, number, number],
  /** 재장전 때 더하는 자세 둘: 총을 안쪽으로 기울이기(cant), 화면 아래로 내리기(down) */
  cant: { pos: [0.02, -0.03, 0], rot: [0, -0.04, 0.3] } as Pose,
  down: { pos: [-0.05, -0.45, 0.06], rot: [0.55, 0, 0.15] } as Pose,
  /**
   * 팔 굽히기. 좌표는 리그 공간(모델 상자 중심이 원점, 총구가 -Z, 길이는 length에 맞춘 뒤의 미터)이다.
   * 받은 모델의 두 팔은 총에서 양옆 뒤로 벌어져 뻗다가 팔꿈치 너머의 둥근 마개에서 끝난다. 그래서 화면에 팔 토막이
   * 따로 떠 보였다: 넓은 화면에서는 왼팔 전완과 마개가 화면 아래쪽에, 달릴 때는 오른팔 마개가 오른쪽 아래에 나왔다.
   * 정점 셰이더가 팔의 한 지점 너머를 통째로 아래로 돌려서 팔이 화면 밑으로 나가게 한다(모델의 면은 그대로다).
   *  - 왼팔: 손목부터(전완, 팔꿈치, 마개). 전완이 손에서 곧장 아래로 내려간다.
   *  - 오른팔: 마찬가지로 손목부터. 오른쪽 뒤로 벌어지던 전완과 뒤쪽 위로 올라오던 마개가 아래로 내려간다.
   * pivot = 돌리는 자리, from = 받은 모델에서 그 너머가 뻗는 쪽, to = 돌린 뒤 뻗는 쪽, band = 굽힘이 번지는 길이,
   * side = [부호, x]: 부호가 -1이면 x보다 왼쪽, +1이면 x보다 오른쪽의 정점만 굽힌다(총 몸체는 x 0.013~0.11 사이다).
   * 모델을 다시 받으면 다시 재야 한다.
   */
  bends: [
    { pivot: [-0.033, -0.107, -0.038], from: [-0.7, -0.19, 0.69], to: [-0.2, -0.9, 0.4], band: 0.04, side: [-1, 0.005] },
    { pivot: [0.125, -0.045, 0.01], from: [0.42, -0.32, 0.85], to: [0.1, -0.9, 0.42], band: 0.04, side: [1, 0.115] },
  ] as { pivot: [number, number, number]; from: [number, number, number]; to: [number, number, number]; band: number; side: [number, number] }[],
};

/** 굽힘은 두 군데다(셰이더의 배열 크기) */
const BENDS = 2;

type BendUniforms = {
  uBendP: { value: Vector3[] };
  uBendD: { value: Vector3[] };
  uBendAxis: { value: Vector3[] };
  uBendSideN: { value: Vector3[] };
  uBendBand: { value: number[] };
  uBendAngle: { value: number[] };
  uBendSideC: { value: number[] };
};

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * 생성 모델을 그대로 불러 붙인 1인칭 총. Blender를 거치지 않는다: 크기·자리·움직임은 전부 여기서 정한다.
 *
 * 두 손이 총을 쥔 모양까지 모델 하나에 들어 있어서, 손이 총에서 떨어지는 움직임은 만들 수 없다.
 * 다만 두 팔의 끝 쪽은 아래로 굽혀서(FP_DIRECT.bends) 팔이 화면 밑으로 나가게 한다.
 * 재장전은 총을 기울여 화면 아래로 내렸다가(탄창을 가는 동안은 보이지 않는다) 다시 올린다.
 */
export class FpDirect {
  readonly root = new Group();
  readonly muzzle = new Object3D();
  readonly cfg = FP_DIRECT;
  private readonly rig = new Group();
  /** 팔을 굽히는 셰이더 값(메시마다 그 메시의 좌표로 둔다) */
  private readonly bends: { mesh: Mesh; u: BendUniforms }[] = [];
  private cant = 0;
  private down = 0;
  private seat = 0;

  constructor(private readonly parts: FpDirectParts, layer: number) {
    this.rig.add(parts.held, this.muzzle);
    this.root.add(this.rig);
    this.root.traverse((o) => {
      o.layers.set(layer);
      o.frustumCulled = false;
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.receiveShadow = false;
      const vecs = (): Vector3[] => Array.from({ length: BENDS }, () => new Vector3(1, 0, 0));
      const nums = (v: number): number[] => Array.from({ length: BENDS }, () => v);
      const u: BendUniforms = {
        uBendP: { value: vecs() },
        uBendD: { value: vecs() },
        uBendAxis: { value: vecs() },
        uBendSideN: { value: vecs() },
        uBendBand: { value: nums(1) },
        uBendAngle: { value: nums(0) },
        uBendSideC: { value: nums(-1e9) },
      };
      this.bends.push({ mesh: m, u });
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        FpDirect.addArmBend(mat as MeshStandardMaterial, u);
        const sm = mat as MeshStandardMaterial;
        // 생성된 거칠기·금속 지도는 거울에 가깝다(가까이서 젖은 크롬처럼 보인다). 칠한 금속의 값으로 두고 노멀맵만 쓴다
        sm.metalnessMap = null;
        sm.roughnessMap = null;
        sm.aoMap = null;
        sm.metalness = 0.3;
        sm.roughness = 0.55;
        sm.envMapIntensity = 0.3;
        if (sm.normalMap) sm.normalScale.set(0.8, 0.8);
        if (sm.map) sm.map.anisotropy = 8;
        sm.needsUpdate = true;
      }
    });
    this.layout();
    this.update(0, -1);
  }

  /**
   * 정점 셰이더에서 팔을 굽힌다: 굽힘 평면 너머에 있고 총보다 바깥쪽인 정점을 굽힘 자리를 축으로 돌린다.
   * 돌리는 각도는 평면에서 band만큼 가는 동안 0에서 끝까지 부드럽게 커져서, 꺾이지 않고 휜다.
   */
  private static addArmBend(mat: MeshStandardMaterial, u: BendUniforms): void {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
        uniform vec3 uBendP[${BENDS}];
        uniform vec3 uBendD[${BENDS}];
        uniform vec3 uBendAxis[${BENDS}];
        uniform vec3 uBendSideN[${BENDS}];
        uniform float uBendBand[${BENDS}];
        uniform float uBendAngle[${BENDS}];
        uniform float uBendSideC[${BENDS}];
        vec3 fpRot(vec3 v, vec3 k, float a) {
          float c = cos(a);
          float s = sin(a);
          return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
        }
        float fpBendW(int i, vec3 p) {
          if (dot(p, uBendSideN[i]) > uBendSideC[i]) return 0.0;
          return smoothstep(0.0, uBendBand[i], dot(p - uBendP[i], uBendD[i]));
        }`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        for (int i = 0; i < ${BENDS}; i++) objectNormal = fpRot(objectNormal, uBendAxis[i], uBendAngle[i] * fpBendW(i, position));`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        for (int i = 0; i < ${BENDS}; i++) transformed = uBendP[i] + fpRot(transformed - uBendP[i], uBendAxis[i], uBendAngle[i] * fpBendW(i, position));`);
    };
    mat.customProgramCacheKey = () => 'fpArmBend';
  }

  /** 굽힘 수치(리그 공간)를 메시마다 그 메시의 좌표로 옮겨 셰이더에 준다 */
  private placeBend(): void {
    this.root.updateMatrixWorld(true);
    const rigInv = new Matrix4().copy(this.rig.matrixWorld).invert();
    for (const b of this.bends) {
      const fromRig = new Matrix4().multiplyMatrices(rigInv, b.mesh.matrixWorld).invert();
      const scale = new Vector3().setFromMatrixScale(fromRig).x;
      for (let i = 0; i < BENDS; i++) {
        const c = this.cfg.bends[i];
        if (!c) {
          b.u.uBendAngle.value[i] = 0;
          continue;
        }
        b.u.uBendP.value[i].set(...c.pivot).applyMatrix4(fromRig);
        const d = b.u.uBendD.value[i].set(...c.from).transformDirection(fromRig);
        const t = new Vector3(...c.to).transformDirection(fromRig);
        b.u.uBendAxis.value[i].crossVectors(d, t).normalize();
        b.u.uBendAngle.value[i] = Math.acos(Math.min(1, Math.max(-1, d.dot(t))));
        b.u.uBendBand.value[i] = c.band * scale;
        // 부호가 -1이면 x가 기준보다 큰 정점을, +1이면 작은 정점을 건너뛴다
        const n = b.u.uBendSideN.value[i].set(-c.side[0], 0, 0).transformDirection(fromRig);
        b.u.uBendSideC.value[i] = new Vector3(c.side[1], 0, 0).applyMatrix4(fromRig).dot(n);
      }
    }
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

  /**
   * 모델을 세운다: 위는 모델의 +Y 그대로(생성 모델은 그림대로 서서 나온다), 가장 긴 수평 축을 앞뒤로 놓고,
   * 양 끝 중 가는 쪽(총열)이 앞(-Z)을 보게 돌린다. 그다음 상자 중심을 원점에 놓고 길이를 맞춘다.
   * 총구 지점은 맨 앞 정점들의 한가운데다(총열은 상자 중심에서 옆으로 비켜 있다).
   */
  layout(): void {
    const g = this.parts.held;
    this.rig.position.set(0, 0, 0);
    this.rig.rotation.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    g.position.set(0, 0, 0);
    g.rotation.set(0, 0, 0);
    g.scale.setScalar(1);
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
    if (front > back) {
      g.rotation.y += Math.PI;
      pts = FpDirect.points(g);
      box = new Box3().setFromPoints(pts);
    }
    const k = this.cfg.length / dim.z;
    const c = box.getCenter(new Vector3());
    g.scale.setScalar(k);
    g.position.copy(c).multiplyScalar(-k);
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
    this.placeBend();
    this.update(0, -1);
  }

  /**
   * 매 스텝. reload = 재장전 진행도 0..1, 재장전 중이 아니면 음수.
   * 재장전: 총을 안쪽으로 기울인다 → 화면 아래로 내린다(탄창 빼는 소리 0.10) → 다시 올린다(탄창 끼우는 소리 0.66에
   * 맞춰 올라와 살짝 튄다) → 기울기를 푼다(장전 손잡이 소리 0.82).
   */
  update(dt: number, reload: number): void {
    const c = this.cfg;
    const t = reload;
    const on = t >= 0;
    const tCant = on ? smooth(0.02, 0.1, t) * (1 - smooth(0.8, 0.95, t)) : 0;
    const tDown = on ? smooth(0.1, 0.24, t) * (1 - smooth(0.5, 0.65, t)) : 0;
    const tSeat = on ? smooth(0.64, 0.67, t) * (1 - smooth(0.67, 0.76, t)) : 0;
    // 목표를 바로 쓰지 않고 따라가게 한다: 재장전이 도중에 끊겨도 총이 한 프레임에 튀지 않는다
    const follow = Math.min(1, dt * 14 || 1);
    this.cant += (tCant - this.cant) * follow;
    this.down += (tDown - this.down) * follow;
    this.seat += (tSeat - this.seat) * Math.min(1, dt * 40 || 1);
    const a = this.cant;
    const b = this.down;
    this.rig.position.set(
      c.pos[0] + a * c.cant.pos[0] + b * c.down.pos[0],
      c.pos[1] + a * c.cant.pos[1] + b * c.down.pos[1] + this.seat * 0.012,
      c.pos[2] + a * c.cant.pos[2] + b * c.down.pos[2],
    );
    this.rig.rotation.set(
      c.rot[0] + a * c.cant.rot[0] + b * c.down.rot[0],
      c.rot[1] + a * c.cant.rot[1] + b * c.down.rot[1],
      c.rot[2] + a * c.cant.rot[2] + b * c.down.rot[2],
    );
  }
}

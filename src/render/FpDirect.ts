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
};

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * 생성 모델을 그대로 불러 붙인 1인칭 총. Blender를 거치지 않는다: 크기·자리·움직임은 전부 여기서 정한다.
 *
 * 두 손이 총을 쥔 모양까지 모델 하나에 들어 있어서, 손이 총에서 떨어지는 움직임은 만들 수 없다.
 * 재장전은 총을 기울여 화면 아래로 내렸다가(탄창을 가는 동안은 보이지 않는다) 다시 올린다.
 */
export class FpDirect {
  readonly root = new Group();
  readonly muzzle = new Object3D();
  readonly cfg = FP_DIRECT;
  private readonly rig = new Group();
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
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
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

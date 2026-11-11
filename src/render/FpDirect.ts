import { Box3, Euler, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';

/** 힉스필드에서 받은 모델 셋(총, 탄창, 팔). 받은 그대로다: 뼈대도 애니메이션도 없다 */
export interface FpDirectParts {
  gun: Group;
  mag: Group;
  arm: Group;
}

type Pose = { pos: [number, number, number]; rot: [number, number, number] };

/**
 * 1인칭 총의 배치 수치. 좌표는 카메라 공간(+X 오른쪽, +Y 위, -Z 앞), 길이는 미터, 각도는 라디안(XYZ 순서).
 * '총 공간'은 총 상자의 중심이 원점이고 총구가 -Z를 본다. 팔의 자세는 '쥔 자리'(손아귀 한가운데)가 놓일 곳이다.
 * 자세의 회전은 [x, y, z]: 먼저 x(전완 축으로 손목 돌리기), 다음 z(팔꿈치 내리기), 마지막 y(팔꿈치를 뒤로)다.
 * 모델을 다시 받으면 이 수치만 고친다(개발 중에는 콘솔의 __fp.cfg를 바꾸고 __fp.layout()을 부르면 바로 보인다).
 */
export const FP_DIRECT = {
  /** 총 길이와 총 상자 중심의 자리 */
  gunLength: 0.57,
  gunPos: [0.15, -0.19, -0.62] as [number, number, number],
  /** 탄창: 높이, 총 공간에서 꽂혀 있는 자세, 모델을 세우는 회전 */
  magHeight: 0.14,
  magFix: [0, 0, 0] as [number, number, number],
  mag: { pos: [0, -0.08, 0.15], rot: [-0.1, 0, 0] } as Pose,
  /** 팔(전완 + 손): 길이, 모델 안에서 손아귀 한가운데의 자리(길이 1로 맞춘 모델 좌표), 모델을 돌려 세우는 회전 */
  armLength: 0.38,
  armGrip: [0.4, 0.02, 0] as [number, number, number],
  armFix: [0, Math.PI / 2, 0] as [number, number, number],
  /** 왼손: 총열덮개를 아래에서 받친 자세, 탄창을 쥔 자세(둘 다 총 공간) */
  armHold: { pos: [0, -0.045, -0.15], rot: [-Math.PI / 2, 0.6, 0.35] } as Pose,
  armMag: { pos: [0, -0.11, 0.15], rot: [0, 0.9, 0.3] } as Pose,
  /** 탄창을 뽑아 내린 자리(총 공간에서 탄창 자세로부터의 이동)와 화면 밖으로 치운 자리(카메라 공간) */
  magPull: [-0.02, -0.17, 0.02] as [number, number, number],
  armAway: { pos: [-0.1, -0.62, -0.3], rot: [0, 0.9, 0.6] } as Pose,
  /** 재장전 때 총이 기우는 만큼(이동, 회전): 총구를 들고 밑면을 왼쪽으로 돌려 탄창이 화면에 보이게 한다 */
  cant: { pos: [-0.06, 0.07, -0.02], rot: [0.3, -0.05, -1.0] } as Pose,
  /** 오른손: 손잡이를 쥔 자세(총 공간). 왼팔 모델을 좌우로 뒤집어 쓴다 */
  armGripR: { pos: [0, -0.1, 0.07], rot: [0, -1.25, -0.25] } as Pose,
  /**
   * Draw the arms. The generated arm is a forearm that ends in a flat cut, and that end floated in view with nothing behind
   * it. Hidden, the gun is shown alone and the magazine still travels the same path on a reload (out, down, back in).
   */
  showArms: false,
};

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * 생성 모델을 그대로 불러 붙인 1인칭 총. Blender를 거치지 않는다: 크기·자리·움직임은 전부 여기서 정한다.
 *
 *  root(카메라 원점)
 *   ├ gunRig(총의 자리. 재장전 때 기울어진다)
 *   │   ├ 총 모델, 탄창, 오른팔, 총구 지점
 *   └ 왼팔(재장전 때 탄창을 뽑아 내렸다가 새 탄창을 꽂는다)
 *
 * 손가락은 움직이지 않는다(쥔 모양 그대로 팔 전체가 움직인다).
 */
export class FpDirect {
  readonly root = new Group();
  readonly muzzle = new Object3D();
  readonly cfg = FP_DIRECT;
  private readonly gunRig = new Group();
  private readonly gunNode = new Group();
  private readonly magNode = new Group();
  private readonly armL = new Group();
  private readonly armR = new Group();
  private readonly armLInner = new Group();
  private readonly armRInner = new Group();
  private readonly magInner = new Group();
  private cant = 0;
  private seat = 0;
  private armReady = false;
  private readonly armPos = new Vector3();
  private readonly armQuat = new Quaternion();
  private readonly m1 = new Matrix4();
  private readonly m2 = new Matrix4();
  private readonly m3 = new Matrix4();
  private readonly p1 = new Vector3();
  private readonly p2 = new Vector3();
  private readonly q1 = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly s1 = new Vector3();
  private readonly e1 = new Euler();
  /** 총구 끝의 높이(총 공간) */
  private barrelY = 0;

  constructor(private readonly parts: FpDirectParts, layer: number) {
    this.gunNode.add(parts.gun);
    this.magInner.add(parts.mag);
    this.magNode.add(this.magInner);
    this.armLInner.add(parts.arm);
    const right = parts.arm.clone(true);
    this.armRInner.add(right);
    this.armL.add(this.armLInner);
    this.armR.add(this.armRInner);
    this.gunRig.add(this.gunNode, this.magNode, this.armR, this.muzzle);
    this.root.add(this.gunRig, this.armL);
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
    this.fitGun();
    this.layout();
    this.update(0, -1);
  }

  /** 모델의 모든 정점(모델의 부모 기준 좌표)을 돌려준다 */
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
  private static centre(model: Object3D, size: number): Vector3 {
    model.position.set(0, 0, 0);
    model.scale.setScalar(1);
    const box = new Box3().setFromPoints(FpDirect.points(model));
    const dim = box.getSize(new Vector3());
    const k = size / Math.max(dim.x, dim.y, dim.z);
    const c = box.getCenter(new Vector3());
    model.scale.setScalar(k);
    model.position.copy(c).multiplyScalar(-k);
    return dim.multiplyScalar(k);
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
    let sum = 0;
    let n = 0;
    for (const p of fitted) {
      if (p.z > fb.min.z + 0.012) continue;
      sum += p.y;
      n++;
    }
    this.barrelY = n ? sum / n : 0;
    this.muzzle.position.set(0, this.barrelY, fb.min.z);
  }

  /** 배치 수치(cfg)를 모델에 적용한다 */
  layout(): void {
    const c = this.cfg;
    // 탄창: 세우는 회전을 먹인 뒤 높이에 맞춘다
    this.parts.mag.rotation.set(...c.magFix);
    const mp = FpDirect.points(this.parts.mag);
    const mdim = new Box3().setFromPoints(mp).getSize(new Vector3());
    this.parts.mag.position.set(0, 0, 0);
    this.parts.mag.scale.setScalar(1);
    FpDirect.centre(this.parts.mag, c.magHeight * (Math.max(mdim.x, mdim.y, mdim.z) / mdim.y));
    // 팔: 길이에 맞추고, 손아귀 한가운데가 원점에 오게 민다. 오른팔은 좌우로 뒤집는다
    for (const [inner, mirror] of [[this.armLInner, 1], [this.armRInner, -1]] as [Group, number][]) {
      const model = inner.children[0];
      model.rotation.set(...c.armFix);
      FpDirect.centre(model, c.armLength);
      model.position.sub(this.p1.set(c.armGrip[0], c.armGrip[1], c.armGrip[2]).multiplyScalar(c.armLength));
      inner.scale.set(mirror, 1, 1);
    }
    this.poseMatrix(c.armGripR, this.m1).decompose(this.armR.position, this.armR.quaternion, this.s1);
    this.armL.visible = c.showArms;
    this.armR.visible = c.showArms;
    this.armReady = false;
  }

  private poseMatrix(p: Pose, out: Matrix4): Matrix4 {
    return out.compose(this.p2.set(...p.pos), this.q2.setFromEuler(this.e1.set(p.rot[0], p.rot[1], p.rot[2], 'YZX')), this.s1.set(1, 1, 1));
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
    this.gunRig.rotation.set(k * c.cant.rot[0], k * c.cant.rot[1], k * c.cant.rot[2]);
    this.gunRig.updateMatrix();

    // 왼팔: 자세 넷(받침, 탄창, 뽑아 내림, 화면 밖)을 차례로 섞는다. 앞의 셋은 총 공간이라 총이 기울면 함께 간다
    const gm = this.gunRig.matrix;
    const mix = (target: Matrix4, w: number): void => {
      if (w <= 0) return;
      target.decompose(this.p2, this.q2, this.s1);
      this.p1.lerp(this.p2, w);
      this.q1.slerp(this.q2, w);
    };
    this.m1.multiplyMatrices(gm, this.poseMatrix(c.armHold, this.m2)).decompose(this.p1, this.q1, this.s1);
    const atMag = this.m1.multiplyMatrices(gm, this.poseMatrix(c.armMag, this.m2)).clone();
    const pulled: Pose = { pos: [c.armMag.pos[0] + c.magPull[0], c.armMag.pos[1] + c.magPull[1], c.armMag.pos[2] + c.magPull[2]], rot: c.armMag.rot };
    const out = this.m1.multiplyMatrices(gm, this.poseMatrix(pulled, this.m2)).clone();
    const away = this.poseMatrix(c.armAway, this.m2).clone();
    let carried = false;
    if (on) {
      mix(atMag, smooth(0.02, 0.1, t));
      mix(out, smooth(0.1, 0.2, t));
      mix(away, smooth(0.2, 0.33, t));
      mix(out, smooth(0.42, 0.55, t));
      mix(atMag, smooth(0.57, 0.665, t));
      this.m1.multiplyMatrices(gm, this.poseMatrix(c.armHold, this.m3));
      mix(this.m1, smooth(0.72, 0.88, t));
      carried = t > 0.1 && t < 0.665;
    }
    if (!this.armReady) {
      this.armPos.copy(this.p1);
      this.armQuat.copy(this.q1);
      this.armReady = true;
    }
    const follow = Math.min(1, dt * 26 || 1);
    this.armPos.lerp(this.p1, follow);
    this.armQuat.slerp(this.q1, follow);
    this.armL.position.copy(this.armPos);
    this.armL.quaternion.copy(this.armQuat);
    this.armL.updateMatrix();

    // 탄창: 꽂혀 있거나, 손에 들려 있다(쥔 순간의 손과 탄창의 상대 자리를 그대로 지킨다)
    const rest = this.poseMatrix(c.mag, this.m2).clone();
    if (carried) {
      // 총 공간의 탄창 = inv(총) x 손 x inv(총 공간에서 탄창을 쥔 손) x 꽂힌 탄창
      this.m1.copy(gm).invert().multiply(this.armL.matrix).multiply(this.m3.copy(this.poseMatrix(c.armMag, this.m3)).invert()).multiply(rest);
      this.m1.decompose(this.magNode.position, this.magNode.quaternion, this.s1);
    } else rest.decompose(this.magNode.position, this.magNode.quaternion, this.s1);
  }
}

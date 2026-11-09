import { CapsuleGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3, type Material } from 'three';

/**
 * 1인칭 팔 (레이븐 슈트 색): 장갑 낀 손 + 전완 장갑 + 발광 라인 + 손목 패널.
 * 총 홀더 로컬 좌표(총열 -Z, 위 +Y)에 붙여 총과 함께 움직인다. 팔꿈치는 화면 밖에 둔다.
 */
export interface ArmPose {
  /** 손바닥 중심 */
  hand: Vector3;
  /** 팔꿈치 (화면 밖) */
  elbow: Vector3;
  /** 손가락이 감싸는 방향(손바닥 → 손가락 끝) */
  grip: Vector3;
}

export const ARM_POSES: { right: ArmPose; left: ArmPose } = {
  right: { hand: new Vector3(0.05, -0.085, 0.06), elbow: new Vector3(0.21, -0.3, 0.44), grip: new Vector3(-1, -0.15, -0.35) },
  left: { hand: new Vector3(-0.062, -0.035, -0.19), elbow: new Vector3(-0.25, -0.34, 0.1), grip: new Vector3(1, 0.7, -0.1) },
};

const UP = new Vector3(0, 1, 0);

function segment(a: Vector3, b: Vector3, r: number, mat: Material, radial = 16): Mesh {
  const d = b.clone().sub(a);
  const len = d.length();
  const m = new Mesh(new CapsuleGeometry(r, Math.max(0.001, len), 6, radial), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  return m;
}

export function buildFpArms(): Group {
  const root = new Group();
  const armor = new MeshStandardMaterial({ color: 0x1d2c5e, roughness: 0.45, metalness: 0.35 });
  const under = new MeshStandardMaterial({ color: 0x111827, roughness: 0.8, metalness: 0.05 });
  const glove = new MeshStandardMaterial({ color: 0x3a465e, roughness: 0.65, metalness: 0.15 });
  const accent = new MeshStandardMaterial({ color: 0x2f80ff, emissive: 0x2f80ff, emissiveIntensity: 1.1, roughness: 0.4 });
  const white = new MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.45, metalness: 0.25 });

  for (const side of ['right', 'left'] as const) {
    const pose = ARM_POSES[side];
    const arm = new Group();
    const toElbow = pose.elbow.clone().sub(pose.hand).normalize();
    const wrist = pose.hand.clone().addScaledVector(toElbow, 0.075);
    const grip = pose.grip.clone().normalize();
    // 팔 바깥쪽(발광 라인 위치) 방향
    const outward = new Vector3().crossVectors(toElbow, grip).normalize();
    if (side === 'left') outward.negate();

    // 전완: 안쪽 슈트 + 바깥 장갑판
    arm.add(segment(wrist, pose.elbow, 0.036, under));
    const plateA = wrist.clone().addScaledVector(toElbow, 0.03).addScaledVector(outward, 0.012);
    const plateB = pose.elbow.clone().addScaledVector(toElbow, -0.05).addScaledVector(outward, 0.012);
    arm.add(segment(plateA, plateB, 0.04, armor));
    // 발광 라인
    const lineA = plateA.clone().addScaledVector(outward, 0.036).addScaledVector(toElbow, 0.02);
    const lineB = lineA.clone().addScaledVector(toElbow, 0.16);
    arm.add(segment(lineA, lineB, 0.006, accent, 8));
    // 손목 커프: 장갑 링 + 얇은 흰 띠
    arm.add(segment(wrist, wrist.clone().addScaledVector(toElbow, 0.035), 0.042, armor));
    arm.add(segment(wrist.clone().addScaledVector(toElbow, 0.012), wrist.clone().addScaledVector(toElbow, 0.02), 0.045, white, 20));

    // 손: 손바닥 + 손등 장갑 + 감싼 손가락 + 엄지
    // 손바닥(장갑) — 손목까지 이어지는 두툼한 덩어리
    arm.add(segment(pose.hand.clone().addScaledVector(toElbow, -0.02), wrist, 0.04, glove));
    // 손등 장갑판
    const back = pose.hand.clone().addScaledVector(grip, -0.022).addScaledVector(outward, 0.012);
    arm.add(segment(back, back.clone().addScaledVector(toElbow, 0.055), 0.028, armor));
    // 손가락 4개: 손잡이/총열을 감싸며 앞으로 말린다
    const fingerBase = pose.hand.clone().addScaledVector(grip, 0.032).addScaledVector(toElbow, -0.03);
    for (let i = 0; i < 4; i++) {
      const o = (i - 1.5) * 0.02;
      const a = fingerBase.clone().addScaledVector(toElbow, o);
      const mid = a.clone().addScaledVector(grip, 0.03).addScaledVector(outward, -0.012);
      const tip = mid.clone().addScaledVector(outward, -0.025).addScaledVector(grip, 0.008);
      arm.add(segment(a, mid, 0.013, glove, 10));
      arm.add(segment(mid, tip, 0.012, glove, 10));
    }
    // 엄지
    const thumbA = pose.hand.clone().addScaledVector(outward, -0.03).addScaledVector(toElbow, 0.005);
    arm.add(segment(thumbA, thumbA.clone().addScaledVector(grip, 0.035).addScaledVector(toElbow, -0.03), 0.013, glove, 10));
    // 너클 포인트 (작은 발광 점)
    const knuckle = new Mesh(new SphereGeometry(0.006, 10, 8), accent);
    knuckle.position.copy(back).addScaledVector(outward, 0.022);
    arm.add(knuckle);

    arm.name = `fp-arm-${side}`;
    root.add(arm);
  }
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) {
      m.castShadow = false;
      m.receiveShadow = false;
    }
  });
  return root;
}

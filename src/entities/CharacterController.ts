import { Box3, Vector3 } from 'three';
import { GRAVITY } from '@/data/heroes';

/**
 * 키네마틱 캡슐(AABB 근사) 컨트롤러.
 * - 축 분리 이동/해결 (X → Z → Y)
 * - 0.5m 스텝업 (계단/크레이트)
 * - 플레이어와 봇이 공유
 */
export class CharacterController {
  /** 발 위치 */
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  onGround = false;
  radius = 0.4;
  height = 1.8;
  stepHeight = 0.5;
  /** 공중 제어 비율 */
  airControl = 0.65;
  /** 스텝업 직후 시각적 보정량 (물리 위치는 즉시 올라가지만 보이는 위치는 부드럽게 따라감) */
  private stepSmooth = 0;

  /** 렌더용 Y 오프셋: 물리 위치에 더해 쓰면 계단에서 튀지 않는다 */
  get visualYOffset(): number {
    return -this.stepSmooth;
  }
  private lastHorizontal = new Vector3();

  constructor(private readonly colliders: Box3[]) {}

  teleport(p: Vector3): void {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.onGround = false;
  }

  private overlap(p: Vector3): Box3 | null {
    const r = this.radius;
    const h = this.height;
    const eps = 1e-4;
    for (const b of this.colliders) {
      if (
        p.x + r > b.min.x + eps && p.x - r < b.max.x - eps &&
        p.y + h > b.min.y + eps && p.y < b.max.y - eps &&
        p.z + r > b.min.z + eps && p.z - r < b.max.z - eps
      ) return b;
    }
    return null;
  }

  private moveAxis(axis: 0 | 2, d: number): boolean {
    if (d === 0) return false;
    const p = this.pos;
    p.setComponent(axis, p.getComponent(axis) + d);
    let hit = this.overlap(p);
    if (!hit) return false;
    // 스텝업 시도
    if (this.onGround) {
      const saveY = p.y;
      const stepTo = hit.max.y + 0.002;
      if (stepTo - saveY <= this.stepHeight) {
        p.y = stepTo;
        if (!this.overlap(p)) {
          this.stepSmooth = Math.min(this.stepHeight, this.stepSmooth + (stepTo - saveY));
          return false;
        }
        p.y = saveY;
      }
    }
    // 밀어내기 (최대 3회)
    for (let i = 0; i < 3 && hit; i++) {
      const r = this.radius;
      p.setComponent(axis, d > 0 ? hit.min.getComponent(axis) - r - 0.001 : hit.max.getComponent(axis) + r + 0.001);
      hit = this.overlap(p);
    }
    return true;
  }

  /**
   * @param wish 수평 희망 속도 (m/s, xz)
   * @param jumpVel 점프 시 수직 속도 (0이면 점프 안 함)
   * @returns 실제 이동한 수평 거리
   */
  moveAndSlide(dt: number, wish: Vector3, jumpVel = 0): number {
    const start = this.pos.clone();
    // 수평 속도: 지상은 즉시, 공중은 제한된 제어
    if (this.onGround) {
      this.lastHorizontal.set(wish.x, 0, wish.z);
    } else {
      this.lastHorizontal.x += (wish.x - this.lastHorizontal.x) * this.airControl * dt * 4;
      this.lastHorizontal.z += (wish.z - this.lastHorizontal.z) * this.airControl * dt * 4;
    }
    if (jumpVel > 0 && this.onGround) {
      this.vel.y = jumpVel;
      this.onGround = false;
    }
    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -40) this.vel.y = -40;

    this.moveAxis(0, this.lastHorizontal.x * dt);
    this.moveAxis(2, this.lastHorizontal.z * dt);

    // 수직
    this.pos.y += this.vel.y * dt;
    const hit = this.overlap(this.pos);
    if (hit) {
      if (this.vel.y <= 0) {
        this.pos.y = hit.max.y;
        this.onGround = true;
      } else {
        this.pos.y = hit.min.y - this.height - 0.001;
      }
      this.vel.y = 0;
    } else {
      // 접지 유지 체크 (살짝 아래)
      if (this.onGround) {
        this.pos.y -= 0.05;
        const g = this.overlap(this.pos);
        if (g && this.vel.y <= 0) {
          this.pos.y = g.max.y;
        } else {
          this.pos.y += 0.05;
          this.onGround = false;
        }
      }
    }
    // 맵 밖 안전장치
    if (this.pos.y < -20) {
      this.pos.set(0, 1, 0);
      this.vel.set(0, 0, 0);
    }
    // 스텝 스무딩 감쇠
    this.stepSmooth *= Math.exp(-dt * 14);
    if (this.stepSmooth < 0.002) this.stepSmooth = 0;
    const dx = this.pos.x - start.x;
    const dz = this.pos.z - start.z;
    return Math.hypot(dx, dz);
  }
}

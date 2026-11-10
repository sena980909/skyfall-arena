import { Vector3 } from 'three';
import type { PlayerInput } from '@/core/PlayerInput';
import type { GameContext } from '@/core/Context';
import type { Bot } from '@/entities/Bot';
import type { HealthPack } from '@/world/HealthPack';
import { losBlocked } from '@/combat/Hitscan';
import { angleBetweenDeg, DEG2RAD, gaussian, randRange } from '@/core/MathUtil';

/**
 * 오토파일럿 — 사람처럼 플레이어를 조작하는 입력 에뮬레이터 (F8).
 * 밸런스 플레이테스트/데모용. 반응시간, 조준 오차, 추적 속도, 버스트, 스트레이프, 스킬 판단을 흉내 낸다.
 */
export interface AutopilotProfile {
  reactionTime: number;
  aimSigmaDeg: number;
  aimSpeedDeg: number;
  headshotPref: number;
  fireErrorDeg: number;
}

export const AUTOPILOT_PROFILES: Record<'casual' | 'average' | 'good', AutopilotProfile> = {
  casual: { reactionTime: 0.4, aimSigmaDeg: 1.8, aimSpeedDeg: 220, headshotPref: 0.15, fireErrorDeg: 3.5 },
  average: { reactionTime: 0.25, aimSigmaDeg: 1.0, aimSpeedDeg: 360, headshotPref: 0.35, fireErrorDeg: 2.5 },
  good: { reactionTime: 0.17, aimSigmaDeg: 0.6, aimSpeedDeg: 520, headshotPref: 0.55, fireErrorDeg: 1.8 },
};

export class Autopilot implements PlayerInput {
  readonly mouseDown = [false, false, false];
  readonly mousePressed = [false, false, false];
  private readonly keys = new Set<string>();
  private readonly pressedOnce = new Set<string>();
  private dx = 0;
  private dy = 0;

  target: Bot | null = null;
  /** 임무 목표 지점(Game이 매 스텝 넣어 준다). 적이 안 보이면 그곳으로 가서 상호작용하고, urgent면 싸우지 않고 달린다 */
  objective: { pos: Vector3; interact: boolean; urgent: boolean; radius: number } | null = null;
  private targetSince = 0;
  private errYaw = 0;
  private errPitch = 0;
  private nextErr = 0;
  private aimHead = false;
  private strafeDir = 1;
  private nextStrafeFlip = 0;
  private triggerUntil = 0;
  private triggerPauseUntil = 0;
  private path: Vector3[] = [];
  private pathIdx = 0;
  private nextRepath = 0;
  private readonly lastPos = new Vector3();
  private stuckTimer = 0;
  private readonly stuckAnchor = new Vector3();
  private lastStuckAt = -Infinity;
  private stuckCount = 0;
  private detourUntil = 0;
  private detourGoal: Vector3 | null = null;
  private backUntil = 0;
  private backBlocked = false;
  private goalPack: HealthPack | null = null;
  /** 관찰 로그 */
  readonly events: string[] = [];

  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly eyeV = new Vector3();
  private readonly aimV = new Vector3();

  constructor(private readonly ctx: GameContext, readonly profile: AutopilotProfile = AUTOPILOT_PROFILES.average) {
    this.lastPos.copy(ctx.player.position);
  }

  // ---------- PlayerInput ----------
  isDown(code: string): boolean {
    return this.keys.has(code);
  }
  justPressed(code: string): boolean {
    return this.pressedOnce.has(code);
  }
  consumeMouse(): { dx: number; dy: number } {
    const r = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return r;
  }
  endFrame(): void {
    this.pressedOnce.clear();
    this.mousePressed.fill(false);
  }

  private press(code: string): void {
    this.pressedOnce.add(code);
    this.keys.add(code);
  }

  private log(msg: string): void {
    if (this.events.length < 400) this.events.push(`${this.ctx.now.toFixed(1)}s ${msg}`);
  }

  // ---------- 판단 ----------

  /** 매 시뮬레이션 스텝, player.update 직전에 호출 */
  think(dt: number): void {
    const ctx = this.ctx;
    const p = ctx.player;
    const now = ctx.now;
    this.keys.clear();
    this.mouseDown[0] = false;
    this.mouseDown[2] = false;
    if (!p.alive) return;


    const eye = this.eyeV.copy(p.position).setY(p.position.y + 1.6);
    const visible = this.visibleBots(eye);
    this.pickTarget(visible, now);

    const obj = this.objective;
    const atObj = !!obj && Math.hypot(p.position.x - obj.pos.x, p.position.z - obj.pos.z) < obj.radius * 0.6 && Math.abs(p.position.y - obj.pos.y) < 2.5;
    if (this.target && !obj?.urgent) {
      // 3인칭에서는 조준선이 카메라(오른쪽 어깨 뒤)에서 나가므로, 눈 위치가 아니라 카메라 위치에서 각도를 잡아야 조준점이 맞는다
      this.combat(dt, this.target, visible.length, p.thirdPerson ? ctx.camera.position : eye);
    } else {
      this.roam(dt, atObj);
    }
    // 목표 지점 근처에서는 상호작용 키를 누르고 있는다(싸우는 중에도)
    if (obj?.interact && Math.hypot(p.position.x - obj.pos.x, p.position.z - obj.pos.z) < obj.radius && Math.abs(p.position.y - obj.pos.y) < 2.5) this.keys.add('KeyF');
    this.abilities(visible, now);
    this.stuckCheck(dt);
  }

  private visibleBots(eye: Vector3): Bot[] {
    const out: Bot[] = [];
    for (const b of this.ctx.bots) {
      if (!b.alive) continue;
      const chest = this.tmp2.copy(b.position).setY(b.position.y + 1.0 * b.scale);
      if (chest.distanceTo(eye) > 60) continue;
      if (losBlocked(eye, chest, this.ctx.map.meshes)) continue;
      out.push(b);
    }
    return out;
  }

  private pickTarget(visible: Bot[], now: number): void {
    const p = this.ctx.player.position;
    // 현재 타겟 유지 (보이는 동안)
    if (this.target && (!this.target.alive || !visible.includes(this.target))) {
      this.target = null;
    }
    if (!this.target && visible.length) {
      // 보스 우선 → 가까운 순
      visible.sort((a, b) => Number(b.isBoss) - Number(a.isBoss) || a.position.distanceTo(p) - b.position.distanceTo(p));
      this.target = visible[0];
      this.targetSince = now;
      this.aimHead = Math.random() < this.profile.headshotPref;
      this.log(`타겟 ${this.target.displayName}`);
    }
  }

  /** 시점을 목표 방향으로 사람처럼 회전시키고, 각도 오차를 반환 (deg) */
  private aimAt(point: Vector3, dt: number, eye: Vector3): number {
    const p = this.ctx.player;
    // 주의: 호출자가 eye로 tmp2를 넘기므로 여기서는 별도 벡터를 쓴다 (같은 벡터면 dir=0 → atan2(-0,-0)=-π로 항상 +z를 본다)
    const dir = this.aimV.copy(point).sub(eye);
    const dist = dir.length();
    dir.divideScalar(dist || 1);
    const desiredYaw = Math.atan2(-dir.x, -dir.z);
    const desiredPitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    // 오차 (주기적으로 갱신, 거리에 따라 살짝 커짐)
    if (this.ctx.now >= this.nextErr) {
      this.nextErr = this.ctx.now + 0.3;
      const s = this.profile.aimSigmaDeg * DEG2RAD * (1 + dist / 60);
      this.errYaw = gaussian() * s;
      this.errPitch = gaussian() * s * 0.6;
    }
    const targetYaw = desiredYaw + this.errYaw;
    const targetPitch = desiredPitch + this.errPitch;
    let dYaw = targetYaw - p.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = targetPitch - p.pitch;
    const maxStep = this.profile.aimSpeedDeg * DEG2RAD * dt;
    const stepYaw = Math.max(-maxStep, Math.min(maxStep, dYaw));
    const stepPitch = Math.max(-maxStep, Math.min(maxStep, dPitch));
    // Player: yaw -= dx*sens, pitch -= dy*sens
    this.dx = -stepYaw / p.sensitivity;
    this.dy = -stepPitch / p.sensitivity;
    // 실제 오차: 현재 시선과 목표(오차 없는) 방향 사이 각도
    const cur = new Vector3(-Math.sin(p.yaw + stepYaw) * Math.cos(p.pitch + stepPitch), Math.sin(p.pitch + stepPitch), -Math.cos(p.yaw + stepYaw) * Math.cos(p.pitch + stepPitch));
    return angleBetweenDeg(cur, dir);
  }

  private combat(dt: number, target: Bot, visibleCount: number, eye: Vector3): void {
    const ctx = this.ctx;
    const p = ctx.player;
    const now = ctx.now;
    const dist = target.position.distanceTo(p.position);
    const aimPoint = this.aimV.copy(target.position);
    aimPoint.y += (this.aimHead && dist < 25 ? 1.62 : 1.0) * target.scale;
    const err = this.aimAt(aimPoint, dt, eye);

    // 사격 (반응시간 후, 오차 안쪽, 버스트 패턴)
    const acquired = now - this.targetSince >= this.profile.reactionTime;
    if (acquired && err < this.profile.fireErrorDeg && p.weapon.ammo > 0 && !p.weapon.reloading) {
      if (now >= this.triggerPauseUntil) {
        if (this.triggerUntil <= now) {
          this.triggerUntil = now + randRange(0.4, 0.9);
        }
        if (now < this.triggerUntil) this.mouseDown[0] = true;
        else this.triggerPauseUntil = now + randRange(0.1, 0.25);
      }
    }
    // 재장전 판단
    if (p.weapon.ammo <= 5 && !p.weapon.reloading && !p.ultActive && (dist > 18 || visibleCount === 0)) this.press('KeyR');

    // 이동: 거리 유지 + 스트레이프 (뒤가 막혀 있으면 후진 대신 옆으로)
    const moved = p.position.distanceTo(this.lastPos);
    if (dist < 7 && !(this.backBlocked && moved < 0.02)) this.keys.add('KeyS');
    else if (dist > 24) this.keys.add('KeyW');
    this.backBlocked = dist < 7 && moved < 0.02;
    if (now >= this.nextStrafeFlip) {
      this.nextStrafeFlip = now + randRange(0.8, 1.6);
      this.strafeDir *= -1;
    }
    this.keys.add(this.strafeDir > 0 ? 'KeyD' : 'KeyA');
    this.path = [];
    this.goalPack = null;
  }

  private roam(dt: number, atObjective = false): void {
    const ctx = this.ctx;
    const p = ctx.player;
    const now = ctx.now;
    // 목적지: 끼임 우회 → 체력 낮으면 힐팩 → 가장 가까운 봇
    let goal: Vector3 | null = null;
    if (now < this.backUntil) {
      this.keys.add('KeyS');
      return;
    }
    if (now < this.detourUntil && this.detourGoal) goal = this.detourGoal;
    // 제한 시간 탈출 중에는 힐팩을 찾아다니지 않는다(맞으면서 팩 사이를 오가다 시간을 다 쓴 판이 있었다). 거의 죽을 때 가까운 것만 집는다
    const urgent = !!this.objective?.urgent;
    if (!goal && p.hp < (urgent ? 50 : 120)) {
      let best: HealthPack | null = null;
      let bd = Infinity;
      for (const pk of ctx.packs) {
        if (!pk.active) continue;
        const d = pk.position.distanceTo(p.position);
        if (d < bd && d < (urgent ? 15 : 45)) {
          bd = d;
          best = pk;
        }
      }
      if (best) {
        goal = best.position;
        if (this.goalPack !== best) this.log(`힐팩으로 이동 (HP ${p.hp})`);
        this.goalPack = best;
      }
    }
    if (!goal && this.objective) {
      // 임무 목표가 있으면 그쪽으로. 도착했으면 그 자리에 선다
      this.goalPack = null;
      if (atObjective) return;
      goal = this.objective.pos;
    }
    if (!goal) {
      this.goalPack = null;
      let bd = Infinity;
      for (const b of ctx.bots) {
        if (!b.alive) continue;
        const d = b.position.distanceTo(p.position);
        if (d < bd) {
          bd = d;
          goal = b.position;
        }
      }
    }
    if (!goal) {
      this.keys.clear();
      return;
    }
    if (now >= this.nextRepath || this.pathIdx >= this.path.length) {
      this.nextRepath = now + 0.7;
      this.path = ctx.nav.findPath(p.position, goal);
      this.pathIdx = 0;
    }
    if (this.pathIdx >= this.path.length) return;
    const wp = this.path[this.pathIdx];
    const flat = this.tmp.copy(wp).sub(p.position).setY(0);
    if (flat.length() < 0.7) {
      // 모서리를 다 돌기 전에 다음 지점으로 넘어가면 방벽 끝에 걸려 제자리에서 민다(경로를 다시 잡아도 같은 자리라 풀리지 않는다).
      // 다음 지점까지 곧게 갈 수 있을 때만, 아니면 이 지점에 거의 닿았을 때만 넘어간다
      const next = this.path[this.pathIdx + 1];
      if (!next || flat.length() < 0.25 || ctx.nav.clearLine(p.position, next)) {
        this.pathIdx++;
        return;
      }
    }
    // 웨이포인트를 바라보며 전진 (피치는 수평으로)
    const eye = this.tmp2.copy(p.position).setY(p.position.y + 1.6);
    const look = wp.clone().setY(eye.y);
    this.aimAt(look, dt, eye);
    this.keys.add('KeyW');
    this.keys.add('ShiftLeft');
  }

  private abilities(visible: Bot[], now: number): void {
    const p = this.ctx.player;
    const ab = p.hero.abilities;
    // 펄스 로켓: 조준이 잡힌 타겟이 5~30m
    if (this.target && now >= p.rocketReadyAt && now - this.targetSince > this.profile.reactionTime + 0.15) {
      const d = this.target.position.distanceTo(p.position);
      if (d > 5 && d < 30) {
        this.mouseDown[2] = true;
        this.log(`펄스 로켓 (${d.toFixed(0)}m)`);
      }
    }
    // 치유 필드: 체력이 낮아지면 발밑에 설치
    if (p.hp < 120 && now >= p.fieldReadyAt) {
      this.press('KeyE');
      this.log(`치유 필드 (HP ${Math.round(p.hp)})`);
    }
    // 궁: 충전 완료 + 2체 이상 보이거나 보스
    if (p.ultCharge >= ab.ult.chargeNeeded && !p.ultActive && (visible.length >= 2 || visible.some((b) => b.isBoss))) {
      this.press('KeyQ');
      this.log(`전술 조준 (봇 ${visible.length}체)`);
    }
  }

  private stuckCheck(dt: number): void {
    const p = this.ctx.player;
    const wantsMove = this.keys.has('KeyW') || this.keys.has('KeyA') || this.keys.has('KeyD') || this.keys.has('KeyS');
    this.lastPos.copy(p.position);
    // 한 스텝의 이동량이 아니라 0.8초 동안 제자리(30cm 안)인지로 본다: 방벽 모서리에 밀려 조금씩 떨리면
    // 스텝마다는 움직인 것으로 보여서, 예전 방식으로는 끼인 줄 모르고 계속 밀기만 했다
    const off = p.position.distanceTo(this.stuckAnchor);
    if (!wantsMove || off > 0.3) {
      this.stuckAnchor.copy(p.position);
      this.stuckTimer = 0;
    } else {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.8) {
        if (this.ctx.now - this.lastStuckAt > 6) this.stuckCount = 0;
        this.lastStuckAt = this.ctx.now;
        this.stuckCount++;
        this.press('Space');
        this.strafeDir *= -1;
        this.nextRepath = 0;
        this.stuckTimer = 0;
        if (this.stuckCount >= 2) {
          // 반복 끼임: 잠깐 후진 후 근처 랜덤 지점으로 우회
          this.backUntil = this.ctx.now + 0.6;
          this.detourGoal = this.ctx.nav.randomWalkableNear(p.position, 10) ?? null;
          this.detourUntil = this.ctx.now + 4;
          this.target = null;
          this.stuckCount = 0;
          this.log(`끼임 반복 → 우회 (pos ${p.position.x.toFixed(1)}, ${p.position.y.toFixed(1)}, ${p.position.z.toFixed(1)})`);
        } else this.log('끼임 → 점프/방향 전환');
      }
    }
  }
}

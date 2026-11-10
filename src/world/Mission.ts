import {
  AdditiveBlending, BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, TorusGeometry, Vector3,
} from 'three';
import { Bot, type BotOptions } from '@/entities/Bot';
import type { GameContext } from '@/core/Context';

export type MissionStage = 'idle' | 'relays' | 'beacon' | 'defend' | 'boss' | 'extract' | 'done' | 'failed';

/** 오토파일럿·테스트가 읽는 현재 목표 지점 */
export interface MissionGoal {
  pos: Vector3;
  /** 도착하면 F를 눌러 유지해야 하는가 */
  interact: boolean;
  /** 적이 보여도 싸우지 말고 달려가야 하는가(제한 시간 탈출) */
  urgent: boolean;
  radius: number;
}

interface Relay {
  pos: Vector3;
  group: Group;
  light: MeshStandardMaterial;
  progress: number;
  done: boolean;
  ambushed: boolean;
}

interface MissionHooks {
  onScore(points: number, text: string): void;
  onVictory(): void;
  onDefeat(reason: string): void;
  setGate(open: boolean): void;
}

/** 임무 '탈출'의 수치. 남쪽 아레나 → 관문 → 화물 통로 → 북쪽 야드 → (탈출) 다시 남쪽 착륙장 */
/** 중계기 1·2는 남쪽 아레나, 3은 북쪽 야드. 두 기를 복구하면 관문이 열린다 */
const RELAY_SPOTS = [new Vector3(-32, 0, 18), new Vector3(32, 0, -18), new Vector3(-25, 0, -110)];
const GATE_AFTER = 2;
const BEACON_POS = new Vector3(0, 0, -95);
const YARD_CHECKPOINT = new Vector3(0, 0, -89);
const EXTRACT_POS = new Vector3(0, 0, 26);
const INTERACT_RADIUS = 2.6;
const RELAY_HOLD = 2.5;
const BEACON_HOLD = 2.0;
const DEFEND_SECONDS = 60;
const DEFEND_WAVE_EVERY = 10;
const DEFEND_MAX_ALIVE = 4;
const EXTRACT_SECONDS = 55;
const EXTRACT_RADIUS = 3;
const HEAVY: BotOptions = { hpMult: 1.8, scale: 1.15 };
const BOSS: BotOptions = { hpMult: 3, scale: 1.35, boss: true };
export const MISSION_SCORE = { relay: 200, beacon: 200, defend: 400, extract: 500 };

const RED = 0xff5030;
const CYAN = 0x4fe3ff;

/**
 * 임무 진행 관리 — 옵치 스토리 임무처럼 목표를 차례로 수행하고 탈출한다.
 *   아레나의 중계기 2기 복구(F 유지, 손대면 매복) → 관문 개방 → 화물 통로 돌파 → 북쪽 야드의 중계기 복구 → 신호기로 탈출선 호출
 *   → 60초 방어 → 추적자(보스) 처치 → 55초 안에 통로를 되돌아가 남쪽 착륙장의 탈출 지점 도달
 * 죽으면 마지막으로 달성한 목표 지점(체크포인트)에서 부활하고 진행 상황은 유지된다. 목숨은 게임 전체에서 센다.
 */
export class Mission {
  stage: MissionStage = 'idle';
  private relays: Relay[] = [];
  private readonly beacon = new Group();
  private beaconLight: MeshStandardMaterial | null = null;
  private beaconProgress = 0;
  private readonly zone = new Group();
  private built = false;
  private timerEnd = 0;
  private nextWaveAt = 0;
  private waveCount = 0;
  private spawnQueue: { at: number; name: string; opts: BotOptions }[] = [];
  private readonly deadAt = new Map<Bot, number>();
  private boss: Bot | null = null;
  private lastSpawnIdx = -1;
  /** 통로 매복을 이미 터뜨렸는가 */
  private corridorSprung = false;
  private botCounter = 0;
  private readonly checkpoint = new Vector3();
  private readonly tmp = new Vector3();

  constructor(private readonly ctx: GameContext, private readonly hooks: MissionHooks) {}

  get active(): boolean {
    return this.stage !== 'idle' && this.stage !== 'done' && this.stage !== 'failed';
  }

  /** 부활 위치: 마지막으로 달성한 목표 지점 */
  get respawnPoint(): Vector3 {
    return this.checkpoint;
  }

  get aliveBots(): number {
    return this.ctx.bots.filter((b) => b.alive).length + this.spawnQueue.length;
  }

  get relaysDone(): number {
    return this.relays.filter((r) => r.done).length;
  }

  /** 남은 제한 시간(초). 방어·탈출 단계에서만 의미가 있다 */
  get timeLeft(): number {
    return Math.max(0, this.timerEnd - this.ctx.now);
  }

  // ---------- 준비 ----------

  private build(): void {
    if (this.built) return;
    this.built = true;
    const dark = new MeshStandardMaterial({ color: 0x1b2230, roughness: 0.6, metalness: 0.4 });
    const makeConsole = (h: number): { group: Group; light: MeshStandardMaterial } => {
      const group = new Group();
      const light = new MeshStandardMaterial({ color: 0x221008, emissive: RED, emissiveIntensity: 1.6, roughness: 0.4 });
      const base = new Mesh(new BoxGeometry(0.9, 0.4, 0.9), dark);
      base.position.y = 0.2;
      const post = new Mesh(new CylinderGeometry(0.14, 0.2, h, 10), dark);
      post.position.y = 0.4 + h / 2;
      const head = new Mesh(new BoxGeometry(0.5, 0.3, 0.5), dark);
      head.position.y = 0.4 + h + 0.15;
      const ring = new Mesh(new TorusGeometry(0.34, 0.05, 8, 20), light);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.4 + h * 0.55;
      const lamp = new Mesh(new BoxGeometry(0.3, 0.12, 0.3), light);
      lamp.position.y = 0.4 + h + 0.36;
      for (const m of [base, post, head]) m.castShadow = true;
      group.add(base, post, head, ring, lamp);
      return { group, light };
    };
    for (const pos of RELAY_SPOTS) {
      const { group, light } = makeConsole(1.5);
      group.position.copy(pos);
      this.ctx.scene.add(group);
      this.relays.push({ pos: pos.clone(), group, light, progress: 0, done: false, ambushed: false });
    }
    const b = makeConsole(0.9);
    this.beacon.add(b.group);
    this.beacon.position.copy(BEACON_POS);
    this.beaconLight = b.light;
    this.ctx.scene.add(this.beacon);

    // 탈출 지점: 바닥 고리 + 옅은 빛기둥
    const green = new MeshStandardMaterial({ color: 0x0c2a1a, emissive: 0x4dffa0, emissiveIntensity: 2.0 });
    const ring = new Mesh(new TorusGeometry(EXTRACT_RADIUS, 0.09, 8, 48), green);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;
    const beam = new Mesh(
      new CylinderGeometry(EXTRACT_RADIUS, EXTRACT_RADIUS, 14, 32, 1, true),
      new MeshBasicMaterial({ color: 0x4dffa0, transparent: true, opacity: 0.07, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
    );
    beam.position.y = 7;
    this.zone.add(ring, beam);
    this.zone.position.copy(EXTRACT_POS);
    this.ctx.scene.add(this.zone);
  }

  private setVisible(v: boolean): void {
    for (const r of this.relays) r.group.visible = v;
    this.beacon.visible = v;
    this.zone.visible = false;
  }

  /** 임무를 끄고 표시물을 숨긴다(아레나 모드로 시작할 때) */
  stop(): void {
    this.stage = 'idle';
    this.spawnQueue = [];
    if (this.built) this.setVisible(false);
    this.ctx.hud.setObjectiveMarker(null, this.ctx.camera);
    this.ctx.hud.setInteract(null);
  }

  start(): void {
    this.build();
    this.setVisible(true);
    for (const r of this.relays) {
      r.progress = 0;
      r.done = false;
      r.ambushed = false;
      r.light.emissive.setHex(RED);
    }
    this.beaconProgress = 0;
    this.beaconLight?.emissive.setHex(RED);
    this.spawnQueue = [];
    this.deadAt.clear();
    this.boss = null;
    this.botCounter = 0;
    this.waveCount = 0;
    this.checkpoint.copy(this.ctx.map.playerSpawn);
    this.hooks.setGate(false);
    this.corridorSprung = false;
    this.stage = 'relays';
    this.ctx.hud.setBoss(null);
    this.ctx.hud.setRest('');
    this.ctx.hud.killFeed('임무 시작 — 중계기 3기를 복구하라', 'hs');
    this.ctx.sfx.waveStart();
    this.queue(3, 0.8);
  }

  // ---------- 적 등장 ----------

  private pickSpawn(): Vector3 {
    // 관문이 닫혀 있으면 아레나 지점만, 열리면 야드 지점도 쓴다. 너무 먼 지점(75m 밖)은 빼서 적이 금방 도착하게 한다
    const map = this.ctx.map;
    const spawns = map.gateOpen ? [...map.botSpawns, ...map.yardSpawns] : map.botSpawns;
    const p = this.ctx.player.position;
    const far = spawns.map((s, i) => ({ s, i, d: s.distanceTo(p) })).filter((c) => c.d >= 22 && c.d <= 75 && c.i !== this.lastSpawnIdx);
    const pool = far.length ? far : spawns.map((s, i) => ({ s, i, d: 0 }));
    const c = pool[Math.floor(Math.random() * pool.length)];
    this.lastSpawnIdx = c.i;
    return c.s.clone().add(new Vector3((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5));
  }

  /** 일반병 n명(+중장병)을 0.5초 간격으로 등장 대기열에 넣는다 */
  private queue(n: number, delay: number, heavies = 0): void {
    let t = this.ctx.now + delay;
    for (let i = 0; i < n; i++, t += 0.5) {
      this.botCounter++;
      this.spawnQueue.push({ at: t, name: `돌격병 ${this.botCounter}`, opts: {} });
    }
    for (let i = 0; i < heavies; i++, t += 0.5) {
      this.botCounter++;
      this.spawnQueue.push({ at: t, name: `중장병 ${this.botCounter}`, opts: HEAVY });
    }
  }

  private spawn(name: string, opts: BotOptions): Bot {
    const bot = new Bot(this.ctx, name, this.pickSpawn(), opts);
    this.ctx.bots.push(bot);
    this.ctx.scene.add(bot.group, bot.debugLine);
    bot.setDebug(this.ctx.debug);
    // 등장하자마자 플레이어 쪽으로 오게 한다(임무에서는 적이 목표 지점으로 몰려와야 한다)
    bot.hear(this.ctx.player.position);
    return bot;
  }

  /** 죽은 지 4초 지난 봇은 목록에서 뺀다(임무는 웨이브 경계가 없어 계속 쌓인다) */
  private prune(): void {
    const now = this.ctx.now;
    const bots = this.ctx.bots;
    for (let i = bots.length - 1; i >= 0; i--) {
      const b = bots[i];
      if (b.alive) continue;
      const t = this.deadAt.get(b);
      if (t === undefined) this.deadAt.set(b, now);
      else if (now - t > 4) {
        this.ctx.scene.remove(b.debugLine);
        bots.splice(i, 1);
        this.deadAt.delete(b);
      }
    }
  }

  // ---------- 진행 ----------

  /** 지점 근처에서 F를 누르고 있으면 진행도가 차고, 떼거나 벗어나면 천천히 줄어든다. 완료되면 true */
  private hold(pos: Vector3, progress: number, seconds: number, dt: number, label: string): { progress: number; near: boolean } {
    const p = this.ctx.player;
    const d = this.tmp.copy(p.position).sub(pos);
    const near = p.alive && Math.hypot(d.x, d.z) <= INTERACT_RADIUS && Math.abs(d.y) < 2.5;
    if (near && this.ctx.input.isDown('KeyF')) progress = Math.min(1, progress + dt / seconds);
    else progress = Math.max(0, progress - dt * 0.4);
    if (near) this.ctx.hud.setInteract(progress > 0 ? label : `F 길게 눌러 ${label}`, progress);
    return { progress, near };
  }

  private nearestOpenRelay(): Relay | null {
    const p = this.ctx.player.position;
    let best: Relay | null = null;
    let bd = Infinity;
    for (const r of this.relays) {
      if (r.done) continue;
      const d = r.pos.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  }

  /** 현재 목표 지점. 없으면(방어·보스) null */
  goal(): MissionGoal | null {
    if (this.stage === 'relays') {
      const r = this.nearestOpenRelay();
      return r ? { pos: r.pos, interact: true, urgent: false, radius: INTERACT_RADIUS } : null;
    }
    if (this.stage === 'beacon') return { pos: BEACON_POS, interact: true, urgent: false, radius: INTERACT_RADIUS };
    if (this.stage === 'extract') return { pos: EXTRACT_POS, interact: false, urgent: true, radius: EXTRACT_RADIUS };
    return null;
  }

  update(dt: number): void {
    if (!this.active) return;
    const ctx = this.ctx;
    const now = ctx.now;
    const hud = ctx.hud;
    while (this.spawnQueue.length && now >= this.spawnQueue[0].at) {
      const s = this.spawnQueue.shift()!;
      const bot = this.spawn(s.name, s.opts);
      if (s.opts.boss) this.boss = bot;
    }
    this.prune();
    hud.setInteract(null);
    let markPos: Vector3 | null = null;
    let markLabel = '';

    if (this.stage === 'relays') {
      const r = this.nearestOpenRelay();
      if (r) {
        const res = this.hold(r.pos, r.progress, RELAY_HOLD, dt, '중계기 복구');
        r.progress = res.progress;
        if (r.progress > 0 && !r.ambushed) {
          // 손대는 순간 매복이 온다. 뒤로 갈수록 많아진다
          r.ambushed = true;
          const done = this.relaysDone;
          this.queue(2, 0.4, done >= 2 ? 1 : 0);
          hud.killFeed('매복! 적이 접근한다', 'death');
        }
        if (r.progress >= 1) {
          r.done = true;
          r.light.emissive.setHex(CYAN);
          this.checkpoint.copy(r.pos);
          this.hooks.onScore(MISSION_SCORE.relay, `중계기 복구 ${this.relaysDone} / ${this.relays.length}`);
          if (this.relaysDone === GATE_AFTER && !ctx.map.gateOpen) {
            this.hooks.setGate(true);
            hud.killFeed('북쪽 관문 개방 — 화물 통로를 지나 마지막 중계기로', 'hs');
          }
          ctx.sfx.waveClear();
        }
        markPos = r.pos;
        markLabel = '중계기';
      }
      // 통로에 들어서면 매복이 터진다(한 번)
      if (ctx.map.gateOpen && !this.corridorSprung && ctx.player.position.z < -36) {
        this.corridorSprung = true;
        this.queue(3, 0.2);
        hud.killFeed('통로 매복! 앞뒤에서 온다', 'death');
      }
      hud.setObjective(`목표: 중계기 복구 ${this.relaysDone} / ${this.relays.length}`,
        `${ctx.map.gateOpen ? '북쪽 야드 · ' : ''}남은 적 ${this.aliveBots}`);
      hud.setRest('');
      if (this.relaysDone === this.relays.length) {
        this.stage = 'beacon';
        hud.killFeed('통신 복구 — 야드 중앙의 신호기로 탈출선을 호출하라', 'hs');
      }
    } else if (this.stage === 'beacon') {
      const res = this.hold(BEACON_POS, this.beaconProgress, BEACON_HOLD, dt, '탈출선 호출');
      this.beaconProgress = res.progress;
      markPos = BEACON_POS;
      markLabel = '신호기';
      hud.setObjective('목표: 탈출선 호출', `야드 중앙 신호기 · 남은 적 ${this.aliveBots}`);
      if (this.beaconProgress >= 1) {
        this.beaconLight?.emissive.setHex(CYAN);
        this.checkpoint.copy(YARD_CHECKPOINT);
        this.stage = 'defend';
        this.timerEnd = now + DEFEND_SECONDS;
        this.nextWaveAt = now + 1;
        this.hooks.onScore(MISSION_SCORE.beacon, '탈출선 호출');
        hud.killFeed(`탈출선 도착까지 ${DEFEND_SECONDS}초 — 버텨라`, 'death');
        ctx.sfx.waveStart();
      }
    } else if (this.stage === 'defend') {
      if (now >= this.nextWaveAt) {
        this.nextWaveAt = now + DEFEND_WAVE_EVERY;
        this.waveCount++;
        const room = DEFEND_MAX_ALIVE - this.aliveBots;
        if (room > 0) {
          const heavy = this.waveCount % 3 === 0 && room >= 2 ? 1 : 0;
          this.queue(Math.min(2, room) - heavy, 0.2, heavy);
        }
      }
      hud.setObjective('목표: 탈출선이 올 때까지 방어', `남은 적 ${this.aliveBots}`);
      hud.setRest(`탈출선 도착까지 ${Math.ceil(this.timeLeft)}초`);
      if (now >= this.timerEnd) {
        this.stage = 'boss';
        this.hooks.onScore(MISSION_SCORE.defend, '방어 성공');
        this.spawnQueue.push({ at: now + 0.8, name: '추적자', opts: BOSS });
        this.queue(2, 1.4);
        hud.killFeed('추적자 출현 — 처치해야 탈출할 수 있다', 'death');
        ctx.sfx.waveStart();
      }
    } else if (this.stage === 'boss') {
      hud.setObjective('목표: 추적자 처치', `남은 적 ${this.aliveBots}`);
      hud.setRest('');
      if (this.boss) {
        hud.setBoss(this.boss.alive ? { name: this.boss.displayName, hp: this.boss.hp, max: this.boss.maxHp } : null);
        if (!this.boss.alive) {
          this.boss = null;
          this.stage = 'extract';
          this.timerEnd = now + EXTRACT_SECONDS;
          this.zone.visible = true;
          this.checkpoint.copy(YARD_CHECKPOINT);
          this.queue(2, 1.0);
          hud.killFeed(`탈출선 도착 — ${EXTRACT_SECONDS}초 안에 통로를 지나 남쪽 착륙장으로`, 'hs');
          ctx.sfx.waveClear();
        }
      }
    } else if (this.stage === 'extract') {
      markPos = EXTRACT_POS;
      markLabel = '탈출 지점';
      hud.setObjective('목표: 탈출 지점 도달', `남쪽 착륙장 · 남은 적 ${this.aliveBots}`);
      hud.setRest(`탈출선 출발까지 ${Math.ceil(this.timeLeft)}초`);
      const p = ctx.player;
      const d = this.tmp.copy(p.position).sub(EXTRACT_POS);
      if (p.alive && Math.hypot(d.x, d.z) <= EXTRACT_RADIUS) {
        this.stage = 'done';
        this.zone.visible = false;
        hud.setRest('');
        this.hooks.onScore(MISSION_SCORE.extract, '탈출 성공');
        hud.setObjectiveMarker(null, ctx.camera);
        this.hooks.onVictory();
        return;
      }
      if (now >= this.timerEnd) {
        this.stage = 'failed';
        this.zone.visible = false;
        hud.setRest('');
        hud.setObjectiveMarker(null, ctx.camera);
        this.hooks.onDefeat('탈출선을 놓쳤다');
        return;
      }
    }

    // Hide the marker once the player is at the spot (it would float over the HUD while interacting).
    if (markPos && markPos.distanceTo(ctx.player.position) > 4) {
      const dist = Math.round(markPos.distanceTo(ctx.player.position));
      hud.setObjectiveMarker(this.tmp.copy(markPos).setY(markPos.y + 2.4), ctx.camera, `${markLabel} ${dist}m`);
    } else hud.setObjectiveMarker(null, ctx.camera);
  }
}

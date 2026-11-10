import {
  AdditiveBlending, BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, TorusGeometry, Vector3,
} from 'three';
import { Bot, type BotOptions } from '@/entities/Bot';
import type { GameContext } from '@/core/Context';
import { losBlocked } from '@/combat/Hitscan';

export type MissionStage = 'idle' | 'relays' | 'upload' | 'carry' | 'beacon' | 'defend' | 'boss' | 'extract' | 'done' | 'failed';

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

/** 전원 셀 하나. 한 번에 하나만 들 수 있다 */
interface Cell {
  /** 처음 놓인 자리 */
  spot: Vector3;
  /** 지금 놓인 자리. 들고 있는 동안은 마지막으로 땅을 디딘 자리(죽으면 여기에 떨어진다) */
  ground: Vector3;
  group: Group;
  where: string;
  taken: boolean;
  delivered: boolean;
}

interface MissionHooks {
  onScore(points: number, text: string): void;
  onVictory(): void;
  onDefeat(reason: string): void;
  setGate(open: boolean): void;
}

/** 임무 '탈출'의 수치. 남쪽 아레나 → 관문 → 화물 통로 → 북쪽 야드 → 관제동(실내: 중계기·자료 전송·전원 셀) → 야드 → (탈출) 다시 남쪽 착륙장 */
/** 중계기 1·2는 남쪽 아레나, 3은 관제동 맨 안쪽의 관제실. 두 기를 복구하면 관문이 열린다 */
const RELAY_SPOTS = [new Vector3(-32, 0, 18), new Vector3(32, 0, -18), new Vector3(0, 0, -162)];
/** 관제동에 들어서면 방 안에서 기다리던 적이 나온다(서쪽 방, 동쪽 방, 관제실) */
const BLOCK_AMBUSH = [new Vector3(-15, 0, -149), new Vector3(17, 0, -145), new Vector3(-18, 0, -162)];
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
/** 자료 전송(거점 유지): 관제동 서버실 안. 플레이어가 안에 있고 살아 있는 적이 안에 없을 때만 진행된다 */
const UPLOAD_CENTER = new Vector3(0, 0, -145);
const UPLOAD_HALF_X = 8.0;
const UPLOAD_Z0 = -153.0;
const UPLOAD_Z1 = -137.0;
const UPLOAD_SECONDS = 35;
const UPLOAD_WAVE_EVERY = 8;
const UPLOAD_MAX_ALIVE = 4;
const TERMINAL_POS = new Vector3(-2.6, 0, -152.3);
/** 전원 셀 운반: 전송이 끝나면 셀 둘(서버실, 화물 통로)을 신호기로 옮긴다. 들고 있는 동안은 달릴 수 없고, 죽으면 그 자리에 떨어진다 */
const CELL_SPOTS: { pos: Vector3; where: string }[] = [
  { pos: new Vector3(0, 0, -149.4), where: '서버실' },
  { pos: new Vector3(5.5, 0, -51.5), where: '화물 통로' },
];
const CELL_PICKUP = 1.5;
/** 서버실의 셀을 처음 집으면 로비 양끝에서 적이 나와 나가는 길을 막는다 */
const CELL_GUARDS = [new Vector3(-20, 0, -128), new Vector3(20, 0, -128)];
/** 돌입병: 멀리서 쏘지 않고 3~6m까지 파고든다(서버실 거점을 실제로 빼앗으러 들어온다) */
const RUSH: BotOptions = { rush: true, hpMult: 0.7 };
const AMBER = 0xffb030;
const HEAVY: BotOptions = { hpMult: 1.8, scale: 1.15 };
const BOSS: BotOptions = { hpMult: 3, scale: 1.35, boss: true };
export const MISSION_SCORE = { relay: 200, upload: 300, cell: 150, beacon: 200, defend: 400, extract: 500 };

const RED = 0xff5030;
const CYAN = 0x4fe3ff;

function inUploadRoom(v: Vector3): boolean {
  return Math.abs(v.x) < UPLOAD_HALF_X && v.z > UPLOAD_Z0 && v.z < UPLOAD_Z1 && v.y < 3;
}

/**
 * 임무 진행 관리 — 옵치 스토리 임무처럼 목표를 차례로 수행하고 탈출한다.
 *   아레나의 중계기 2기 복구(F 유지, 손대면 매복) → 관문 개방 → 화물 통로 돌파 → 야드를 지나 관제동(실내)의 관제실에서 중계기 복구
 *   → 서버실에서 자료 전송(거점 유지: 적이 방 안에 있으면 멈춘다) → 전원 셀을 야드의 신호기까지 운반(달리기 불가, 죽으면 떨어뜨린다)
 *   → 신호기로 탈출선 호출
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
  private spawnQueue: { at: number; name: string; opts: BotOptions; pos?: Vector3 }[] = [];
  private readonly deadAt = new Map<Bot, number>();
  private boss: Bot | null = null;
  private lastSpawnIdx = -1;
  /** 통로 매복을 이미 터뜨렸는가 */
  private corridorSprung = false;
  /** 관제동 매복을 이미 터뜨렸는가 */
  private blockSprung = false;
  /** 서버실 거점 표시(바닥 테두리 + 전송 단말) */
  private readonly uplink = new Group();
  private uplinkEdge: MeshStandardMaterial | null = null;
  private uplinkLight: MeshStandardMaterial | null = null;
  private uploadProgress = 0;
  private uploadStarted = false;
  private lastBlockIdx = -1;
  /** 전원 셀 둘. 바닥에 놓여 있을 때만 보인다 */
  private cells: Cell[] = [];
  private held: Cell | null = null;
  /** 들고 있는 셀의 모습. 3인칭 몸의 등(torso 뼈)에 붙인다 */
  private readonly carried = new Group();
  /** 셀을 들고 관제동을 나설 때의 차단조를 이미 불렀는가 */
  private carrySprung = false;
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

  /** 자료 전송 진행도 0..1 */
  get uploadRatio(): number {
    return this.uploadProgress;
  }

  /** 전원 셀을 들고 있는가 */
  get carrying(): boolean {
    return this.held !== null;
  }

  get cellsDelivered(): number {
    return this.cells.filter((c) => c.delivered).length;
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

    // 서버실 거점: 벽을 따라 도는 바닥 테두리(전송 중 청록, 적이 들어오면 빨강)와 전송 단말
    const edge = new MeshStandardMaterial({ color: 0x081018, emissive: CYAN, emissiveIntensity: 0.9, roughness: 0.5 });
    this.uplinkEdge = edge;
    const w = UPLOAD_HALF_X * 2 - 0.5;
    const d = UPLOAD_Z1 - UPLOAD_Z0 - 0.5;
    const zc = (UPLOAD_Z0 + UPLOAD_Z1) / 2;
    // 벽을 따라 도는 가는 띠 넷 + 문턱 셋의 굵은 띠(남쪽 문, 서쪽·동쪽 옆문): 넘어서면 거점 안이다
    const strips: [number, number, number, number][] = [
      [0, UPLOAD_Z0 + 0.25, w, 0.12], [0, UPLOAD_Z1 - 0.25, w, 0.12],
      [-UPLOAD_HALF_X + 0.25, zc, 0.12, d], [UPLOAD_HALF_X - 0.25, zc, 0.12, d],
      [0, UPLOAD_Z1 + 0.15, 4, 0.3], [-UPLOAD_HALF_X - 0.15, zc, 0.3, 3], [UPLOAD_HALF_X + 0.15, zc, 0.3, 3],
    ];
    for (const [x, z, sx, sz] of strips) {
      const m = new Mesh(new BoxGeometry(sx, 0.03, sz), edge);
      m.position.set(x, 0.03, z);
      this.uplink.add(m);
    }
    const term = makeConsole(1.1);
    term.group.position.copy(TERMINAL_POS);
    this.uplinkLight = term.light;
    this.uplink.add(term.group);
    this.ctx.scene.add(this.uplink);

    // 전원 셀: 호박색으로 빛나는 통 + 떨어뜨렸을 때 찾기 쉽게 옅은 빛기둥(천장 4.7m 아래)
    const amber = new MeshStandardMaterial({ color: 0x2a1c05, emissive: AMBER, emissiveIntensity: 2.2, roughness: 0.4 });
    const glowMat = new MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.06, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    const shellGeo = new CylinderGeometry(0.15, 0.15, 0.56, 12);
    const coreGeo = new CylinderGeometry(0.175, 0.175, 0.3, 12);
    const capGeo = new CylinderGeometry(0.2, 0.2, 0.06, 12);
    const glowGeo = new CylinderGeometry(0.32, 0.32, 3.6, 16, 1, true);
    // 등에 멘 셀: torso 뼈 공간은 +Y가 앞, +Z가 위(Blender 축 그대로)라서 통을 세우고 비스듬히 눕힌다
    const upright = new Group();
    upright.rotation.x = Math.PI / 2;
    const backA = new Mesh(capGeo, dark);
    backA.position.y = 0.29;
    const backB = new Mesh(capGeo, dark);
    backB.position.y = -0.29;
    const dimAmber = amber.clone();
    dimAmber.emissiveIntensity = 1.1;
    upright.add(new Mesh(shellGeo, dark), new Mesh(coreGeo, dimAmber), backA, backB);
    this.carried.add(upright);
    this.carried.rotation.y = 0.5;
    this.carried.position.set(0, -0.2, 0.33);
    this.carried.scale.setScalar(0.6);
    for (const spot of CELL_SPOTS) {
      const group = new Group();
      const capA = new Mesh(capGeo, dark);
      capA.position.y = 0.29;
      const capB = new Mesh(capGeo, dark);
      capB.position.y = -0.29;
      const glow = new Mesh(glowGeo, glowMat);
      glow.position.y = 1.6;
      group.add(new Mesh(shellGeo, dark), new Mesh(coreGeo, amber), capA, capB, glow);
      group.visible = false;
      this.ctx.scene.add(group);
      this.cells.push({ spot: spot.pos.clone(), ground: spot.pos.clone(), group, where: spot.where, taken: false, delivered: false });
    }

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
    this.uplink.visible = v;
    for (const c of this.cells) c.group.visible = false;
  }

  /** 임무를 끄고 표시물을 숨긴다(아레나 모드로 시작할 때) */
  stop(): void {
    this.stage = 'idle';
    this.spawnQueue = [];
    this.setHeld(null);
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
    this.blockSprung = false;
    this.uploadProgress = 0;
    this.uploadStarted = false;
    this.uplinkLight?.emissive.setHex(RED);
    this.uplinkEdge?.emissive.setHex(CYAN);
    this.setHeld(null);
    for (const c of this.cells) {
      c.ground.copy(c.spot);
      c.taken = false;
      c.delivered = false;
    }
    this.carrySprung = false;
    this.stage = 'relays';
    this.ctx.hud.setBoss(null);
    this.ctx.hud.setRest('');
    this.ctx.hud.killFeed('임무 시작 — 중계기 3기를 복구하라', 'hs');
    this.ctx.sfx.waveStart();
    this.queue(3, 0.8);
  }

  // ---------- 적 등장 ----------

  private pickSpawn(): Vector3 {
    // 관문이 닫혀 있으면 아레나 지점만, 열리면 야드와 관제동 지점도 쓴다. 너무 먼 지점(75m 밖)은 빼서 적이 금방 도착하게 한다
    const map = this.ctx.map;
    const spawns = map.gateOpen ? [...map.botSpawns, ...map.yardSpawns, ...map.blockSpawns] : map.botSpawns;
    const p = this.ctx.player.position;
    const far = spawns.map((s, i) => ({ s, i, d: s.distanceTo(p) })).filter((c) => c.d >= 22 && c.d <= 75 && c.i !== this.lastSpawnIdx);
    const pool = far.length ? far : spawns.map((s, i) => ({ s, i, d: 0 }));
    const c = pool[Math.floor(Math.random() * pool.length)];
    this.lastSpawnIdx = c.i;
    return c.s.clone().add(new Vector3((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5));
  }

  /** 관제동 안의 등장 지점 하나. 플레이어 눈에 보이지 않는 곳, 10m 넘게 떨어진 곳을 먼저 고른다(눈앞에서 불쑥 나타나지 않게) */
  private pickBlockSpawn(): Vector3 {
    const p = this.ctx.player.position;
    const eye = new Vector3(p.x, p.y + 1.6, p.z);
    const all = this.ctx.map.blockSpawns.map((s, i) => ({ s, i, d: s.distanceTo(p) }));
    const apart = all.filter((c) => c.i !== this.lastBlockIdx && c.d >= 10);
    const hidden = apart.filter((c) => losBlocked(eye, new Vector3(c.s.x, c.s.y + 1.2, c.s.z), this.ctx.map.meshes));
    const pool = hidden.length ? hidden : apart.length ? apart : all;
    const c = pool[Math.floor(Math.random() * pool.length)];
    this.lastBlockIdx = c.i;
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

  private spawn(name: string, opts: BotOptions, pos?: Vector3): Bot {
    const bot = new Bot(this.ctx, name, pos ? pos.clone() : this.pickSpawn(), opts);
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

  private nearestCell(): Cell | null {
    const p = this.ctx.player.position;
    let best: Cell | null = null;
    let bd = Infinity;
    for (const c of this.cells) {
      if (c.delivered) continue;
      const d = c.ground.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /** 들고 있는 셀을 3인칭 몸의 등에 붙이거나 뗀다(1인칭에서는 몸이 안 보이므로 HUD 문구로만 알린다) */
  private setHeld(c: Cell | null): void {
    this.held = c;
    this.ctx.player.carrying = c !== null;
    const torso = c ? this.ctx.player.body?.group.getObjectByName('torso') : null;
    if (torso) torso.add(this.carried);
    else this.carried.removeFromParent();
  }

  /** 현재 목표 지점. 없으면(방어·보스) null */
  goal(): MissionGoal | null {
    if (this.stage === 'relays') {
      const r = this.nearestOpenRelay();
      return r ? { pos: r.pos, interact: true, urgent: false, radius: INTERACT_RADIUS } : null;
    }
    if (this.stage === 'upload') return { pos: UPLOAD_CENTER, interact: false, urgent: false, radius: 3 };
    if (this.stage === 'carry') {
      if (this.held) return { pos: BEACON_POS, interact: false, urgent: false, radius: INTERACT_RADIUS };
      const c = this.nearestCell();
      return c ? { pos: c.ground, interact: false, urgent: false, radius: 1 } : null;
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
      const bot = this.spawn(s.name, s.opts, s.pos);
      if (s.opts.boss) this.boss = bot;
    }
    this.prune();
    hud.setInteract(null);
    let markPos: Vector3 | null = null;
    let markLabel = '';
    // 관제동 안의 표시물은 관제동이 그려질 때만 그린다(Game.frame의 setBlockVisible과 같은 기준)
    const north = ctx.camera.position.z < -32;
    this.uplink.visible = north;
    this.relays[2].group.visible = north;

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
            hud.killFeed('북쪽 관문 개방 — 통로와 야드를 지나 관제동의 마지막 중계기로', 'hs');
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
      // 관제동에 들어서면 방 안에서 기다리던 적이 나온다(한 번)
      if (ctx.map.gateOpen && !this.blockSprung && ctx.player.position.z < -124) {
        this.blockSprung = true;
        BLOCK_AMBUSH.forEach((pos, i) => {
          this.botCounter++;
          this.spawnQueue.push({ at: now + 0.2 + i * 0.3, name: `경비병 ${this.botCounter}`, opts: i === 2 ? HEAVY : {}, pos });
        });
        this.spawnQueue.sort((a, b) => a.at - b.at);
        hud.killFeed('관제동 내부에 적 — 관제실은 양옆 방으로 돌아 들어간다', 'death');
      }
      hud.setObjective(`목표: 중계기 복구 ${this.relaysDone} / ${this.relays.length}`,
        `${ctx.map.gateOpen ? '관제동 관제실 · ' : ''}남은 적 ${this.aliveBots}`);
      hud.setRest('');
      if (this.relaysDone === this.relays.length) {
        this.stage = 'upload';
        hud.killFeed('통신 복구 — 서버실에서 탈출 항로 자료를 전송하라', 'hs');
      }
    } else if (this.stage === 'upload') {
      const p = ctx.player;
      const inside = p.alive && inUploadRoom(p.position);
      let hostiles = 0;
      for (const b of ctx.bots) if (b.alive && inUploadRoom(b.position)) hostiles++;
      if (inside && !this.uploadStarted) {
        this.uploadStarted = true;
        this.nextWaveAt = now + 2.5;
        this.waveCount = 0;
        hud.killFeed('전송 시작 — 적이 서버실에 들어오면 전송이 멈춘다', 'death');
        ctx.sfx.waveStart();
      }
      if (inside && hostiles === 0) this.uploadProgress = Math.min(1, this.uploadProgress + dt / UPLOAD_SECONDS);
      // 다음 적은 플레이어가 서버실 안에 있는 동안에만 다가온다(죽어서 돌아오는 사이에 적이 쌓이지 않게)
      if (!inside) this.nextWaveAt += dt;
      if (this.uploadStarted && now >= this.nextWaveAt) {
        this.nextWaveAt = now + UPLOAD_WAVE_EVERY;
        this.waveCount++;
        const n = Math.min(2, UPLOAD_MAX_ALIVE - this.aliveBots);
        for (let i = 0; i < n; i++) {
          this.botCounter++;
          const heavy = i === 1 && this.waveCount % 3 === 0;
          this.spawnQueue.push({
            at: now + 0.2 + i * 0.5, name: `${heavy ? '중장병' : i === 0 ? '돌입병' : '돌격병'} ${this.botCounter}`,
            opts: heavy ? HEAVY : i === 0 ? RUSH : {}, pos: this.pickBlockSpawn(),
          });
        }
        this.spawnQueue.sort((a, b) => a.at - b.at);
      }
      if (this.uplinkEdge) {
        this.uplinkEdge.emissive.setHex(hostiles ? RED : CYAN);
        this.uplinkEdge.emissiveIntensity = inside && !hostiles ? 1.7 : 0.9;
      }
      if (inside) hud.setInteract(hostiles ? '전송 중단 — 서버실 안의 적을 처치' : '항로 자료 전송 중', this.uploadProgress);
      else {
        markPos = UPLOAD_CENTER;
        markLabel = '서버실';
      }
      hud.setObjective(`목표: 항로 자료 전송 ${Math.floor(this.uploadProgress * 100)}%`,
        `${inside ? '서버실을 지켜라' : '관제동 서버실로'} · 남은 적 ${this.aliveBots}`);
      hud.setRest('');
      if (this.uploadProgress >= 1) {
        this.uplinkLight?.emissive.setHex(CYAN);
        if (this.uplinkEdge) {
          this.uplinkEdge.emissive.setHex(CYAN);
          this.uplinkEdge.emissiveIntensity = 0.5;
        }
        this.checkpoint.copy(UPLOAD_CENTER);
        this.stage = 'carry';
        this.hooks.onScore(MISSION_SCORE.upload, '자료 전송 완료');
        hud.killFeed('신호기에 전원이 없다 — 전원 셀 2개(서버실 · 화물 통로)를 야드 신호기로 운반하라', 'hs');
        ctx.sfx.waveClear();
      }
    } else if (this.stage === 'carry') {
      const p = ctx.player;
      const c = this.held;
      if (c) {
        if (!p.alive) {
          // 죽으면 마지막으로 디딘 자리에 떨어진다
          this.setHeld(null);
          hud.killFeed('전원 셀을 떨어뜨렸다 — 쓰러진 자리에 남아 있다', 'death');
        } else {
          if (p.ctrl.onGround) c.ground.copy(p.position);
          if (!this.carrySprung && c === this.cells[0] && p.position.z > -120) {
            this.carrySprung = true;
            this.queue(2, 0.2, 1);
            hud.killFeed('야드에 차단조 — 셀을 든 채로는 달릴 수 없다', 'death');
          }
          const d = this.tmp.copy(p.position).sub(BEACON_POS);
          if (Math.hypot(d.x, d.z) <= INTERACT_RADIUS && Math.abs(d.y) < 2.5) {
            c.delivered = true;
            this.setHeld(null);
            this.checkpoint.copy(YARD_CHECKPOINT);
            const n = this.cellsDelivered;
            this.hooks.onScore(MISSION_SCORE.cell, `전원 셀 장착 ${n} / ${this.cells.length}`);
            ctx.sfx.waveClear();
            const rest = this.nearestCell();
            if (rest) hud.killFeed(`하나 더 — 남은 전원 셀은 ${rest.where}에 있다`, 'hs');
            else {
              this.beaconLight?.emissive.setHex(AMBER);
              this.stage = 'beacon';
              hud.killFeed('전원 연결 — 신호기로 탈출선을 호출하라', 'hs');
            }
          }
        }
      } else if (p.alive) {
        for (const k of this.cells) {
          if (k.delivered) continue;
          const d = this.tmp.copy(p.position).sub(k.ground);
          if (Math.hypot(d.x, d.z) > CELL_PICKUP || Math.abs(d.y) >= 2.5) continue;
          this.setHeld(k);
          ctx.sfx.heal();
          if (k.taken) hud.killFeed('전원 셀 다시 확보', 'hs');
          else {
            k.taken = true;
            if (k === this.cells[0]) {
              CELL_GUARDS.forEach((pos, i) => {
                this.botCounter++;
                this.spawnQueue.push({ at: now + 0.6 + i * 0.4, name: `경비병 ${this.botCounter}`, opts: {}, pos });
              });
              this.spawnQueue.sort((a, b) => a.at - b.at);
            } else this.queue(3, 0.3);
            hud.killFeed('전원 셀 확보 — 야드 신호기로. 들고 있는 동안은 달릴 수 없다', k === this.cells[0] ? 'hs' : 'death');
          }
          break;
        }
      }
      const carry = this.stage === 'carry';
      for (const k of this.cells) {
        k.group.visible = carry && !k.delivered && k !== this.held;
        if (!k.group.visible) continue;
        k.group.position.set(k.ground.x, k.ground.y + 0.62 + Math.sin(now * 2.2) * 0.06, k.ground.z);
        k.group.rotation.y = now * 1.3;
      }
      if (carry) {
        const next = this.held ? null : this.nearestCell();
        markPos = this.held ? BEACON_POS : next ? next.ground : null;
        markLabel = this.held ? '신호기' : '전원 셀';
        hud.setObjective(`목표: 전원 셀 운반 ${this.cellsDelivered} / ${this.cells.length}`,
          `${this.held ? '야드 중앙 신호기로' : next ? `${next.where}의 셀을 집어라` : ''} · 남은 적 ${this.aliveBots}`);
        hud.setRest(this.held ? '전원 셀 운반 중 · 달리기 불가' : '');
      } else hud.setRest('');
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

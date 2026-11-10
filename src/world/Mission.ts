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
  /** 지금 놓인 자리. 들고 있는 동안은 마지막으로 땅을 디딘 자리 */
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

/** 임무 '탈출'의 수치. 안에서 밖으로: 관제동(실내, 시작) → 북쪽 야드 → 화물 통로 → 관문 → 남쪽 착륙장 */
/** 임무 시작 자리: 관제동 맨 안쪽 관제실, 보안 단말 앞(북쪽을 본다) */
export const MISSION_START = new Vector3(0, 0, -158.5);
/** 단말 셋. 0·1 = 남쪽 착륙장의 유도등(마지막에 켠다), 2 = 관제실의 보안 단말(맨 처음 봉쇄를 푼다) */
const RELAY_SPOTS = [new Vector3(-32, 0, 18), new Vector3(32, 0, -18), new Vector3(0, 0, -162)];
/** 시작할 때 관제동에 흩어져 있는 경비병(아직 플레이어를 못 봤다): 서쪽 방, 동쪽 방, 로비. 보안 단말에 손대면 몰려온다 */
const START_GUARDS = [new Vector3(-15, 0, -147), new Vector3(17, 0, -143), new Vector3(8, 0, -127)];
/** 관문이 열릴 때 착륙장 쪽에서 통로를 겨누는 저격병 */
const GATE_MARKSMAN = new Vector3(4, 0, -13);
const BEACON_POS = new Vector3(0, 0, -95);
const EXTRACT_POS = new Vector3(0, 0, 26);
const INTERACT_RADIUS = 2.6;
const RELAY_HOLD = 2.5;
const BEACON_HOLD = 2.0;
const DEFEND_SECONDS = 60;
const DEFEND_WAVE_EVERY = 12;
const DEFEND_MAX_ALIVE = 3;
const EXTRACT_SECONDS = 45;
const EXTRACT_RADIUS = 3;
/** 자료 전송(거점 유지): 관제동 서버실 안. 플레이어가 안에 있고 살아 있는 적이 안에 없을 때만 진행된다 */
const UPLOAD_CENTER = new Vector3(0, 0, -145);
const UPLOAD_HALF_X = 8.0;
const UPLOAD_Z0 = -153.0;
const UPLOAD_Z1 = -137.0;
const UPLOAD_SECONDS = 35;
const UPLOAD_WAVE_EVERY = 10;
const UPLOAD_MAX_ALIVE = 3;
const TERMINAL_POS = new Vector3(-2.6, 0, -152.3);
/** 전원 셀 운반: 전송이 끝나면 셀 둘(서버실, 화물 통로)을 신호기로 옮긴다. 들고 있는 동안은 달릴 수 없다 */
const CELL_SPOTS: { pos: Vector3; where: string }[] = [
  { pos: new Vector3(0, 0, -149.4), where: '서버실' },
  { pos: new Vector3(5.5, 0, -51.5), where: '화물 통로' },
];
const CELL_PICKUP = 1.5;
/** 서버실의 셀을 처음 집으면 로비 양끝에서 적이 나와 나가는 길을 막는다 */
const CELL_GUARDS = [new Vector3(-20, 0, -128), new Vector3(20, 0, -128)];
/** 돌입병: 멀리서 쏘지 않고 3~6m까지 파고든다(서버실 거점을 실제로 빼앗으러 들어온다). 저격병: 멀리서 조준선을 비추고 한 발 */
const RUSH: BotOptions = { kind: 'rusher' };
const MARKSMAN: BotOptions = { kind: 'marksman' };
/** 셀을 들고 야드로 나설 때 야드 남쪽 끝의 저격병 */
const YARD_MARKSMAN = new Vector3(-14, 0, -76);
const AMBER = 0xffb030;
const HEAVY: BotOptions = { hpMult: 1.8, scale: 1.15 };
const BOSS: BotOptions = { hpMult: 3, scale: 1.35, boss: true };
export const MISSION_SCORE = { relay: 200, upload: 300, cell: 150, beacon: 200, defend: 400, extract: 500 };

/** 생성 단말 모델(kit_console)의 기준 높이, 정면을 남쪽(+Z)으로 돌리는 각, 기둥을 두르는 상태 고리의 반지름(기준 크기에서) */
const CONSOLE_REF_HEIGHT = 2.0;
const CONSOLE_YAW = Math.PI;
const CONSOLE_RING = 0.34;
const RED = 0xff5030;
const CYAN = 0x4fe3ff;

function inUploadRoom(v: Vector3): boolean {
  return Math.abs(v.x) < UPLOAD_HALF_X && v.z > UPLOAD_Z0 && v.z < UPLOAD_Z1 && v.y < 3;
}

/** 무전 화자 */
const HQ = '등대';
const SHIP = '제비';
const ME = '레이븐';

/**
 * 임무 '탈출' — 실내에서 시작해 밖으로 빠져나간다. 부활은 없다(쓰러지면 임무 실패).
 *
 * 이야기: 공중 화물 기지 스카이독을 장악한 아르고스 보안군이 화물 항로를 조작해 물자를 빼돌리고 있다.
 * 정찰 요원 레이븐은 증거(항로 기록)를 찾아 관제동에 잠입했지만 경보가 울렸다. 본부 '등대'의 안내로 기록을 전송하고,
 * 탈출선 '제비'를 불러 착륙장에서 빠져나간다.
 *
 *   관제실: 보안 단말로 봉쇄 해제(F 유지, 경비병이 몰려온다)
 *   → 서버실: 항로 기록 전송(거점 유지: 적이 방 안에 있으면 멈춘다)
 *   → 전원 셀 2개(서버실, 화물 통로)를 야드의 신호기로 운반(달리기 불가)
 *   → 신호기로 제비 호출 → 60초 방어 → 추적자(보스) 처치 → 남쪽 관문 개방
 *   → 착륙장: 유도등 2기 점등(F 유지) → 45초 안에 탈출 지점 도달
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
  /** 단말 단계가 두 번 있다: 0 = 관제실 보안 단말(시작), 1 = 착륙장 유도등(끝). openRelays = 지금 손댈 수 있는 단말 */
  private relayStep: 0 | 1 = 0;
  private openRelays: Relay[] = [];
  /** 한 번만 나오는 무전을 이미 했는가 */
  private readonly said = new Set<string>();
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
  private readonly tmp = new Vector3();

  constructor(private readonly ctx: GameContext, private readonly hooks: MissionHooks) {}

  get active(): boolean {
    return this.stage !== 'idle' && this.stage !== 'done' && this.stage !== 'failed';
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
    // 단말 몸체: 맵 키트에 생성 모델(kit_console, 기준 높이 2m)이 있으면 그것을 높이에 맞춰 쓰고, 없으면 상자·기둥으로 만든다.
    // 상태(빨강 → 청록)를 알리는 고리와 등은 어느 쪽이든 따로 붙인다(게임이 색을 바꾼다)
    const kitConsole = this.ctx.assets?.mapKit?.getObjectByName('kit_console') ?? null;
    const makeConsole = (h: number): { group: Group; light: MeshStandardMaterial } => {
      const group = new Group();
      const light = new MeshStandardMaterial({ color: 0x221008, emissive: RED, emissiveIntensity: 1.6, roughness: 0.4 });
      const top = 0.7 + h;
      let ringR = 0.34;
      if (kitConsole) {
        const model = kitConsole.clone(true);
        const k = top / CONSOLE_REF_HEIGHT;
        model.scale.setScalar(k);
        model.rotation.y = CONSOLE_YAW;
        model.traverse((o) => {
          o.castShadow = true;
          o.receiveShadow = true;
        });
        group.add(model);
        ringR = CONSOLE_RING * k;
      } else {
        const base = new Mesh(new BoxGeometry(0.9, 0.4, 0.9), dark);
        base.position.y = 0.2;
        const post = new Mesh(new CylinderGeometry(0.14, 0.2, h, 10), dark);
        post.position.y = 0.4 + h / 2;
        const head = new Mesh(new BoxGeometry(0.5, 0.3, 0.5), dark);
        head.position.y = 0.4 + h + 0.15;
        for (const m of [base, post, head]) m.castShadow = true;
        group.add(base, post, head);
      }
      const ring = new Mesh(new TorusGeometry(ringR, 0.05, 8, 24), light);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.4 + h * 0.55;
      const lamp = new Mesh(new BoxGeometry(0.3, 0.12, 0.3), light);
      lamp.position.y = top + 0.06;
      group.add(ring, lamp);
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
    this.hooks.setGate(false);
    this.relayStep = 0;
    this.openRelays = [this.relays[2]];
    this.said.clear();
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
    this.ctx.sfx.waveStart();
    // 경비병은 다른 방에서 순찰 중이다. 보안 단말에 손대기 전에는 플레이어 위치를 모른다
    for (const pos of START_GUARDS) {
      this.botCounter++;
      this.spawn(`경비병 ${this.botCounter}`, {}, pos, false);
    }
    const hud = this.ctx.hud;
    hud.comm(HQ, '레이븐, 경보가 울렸다. 아르고스가 네 위치를 안다. 잠입은 여기까지야.');
    hud.comm(HQ, '지금부터는 탈출이다. 눈앞의 보안 단말로 관제동 봉쇄부터 풀어. F를 길게 눌러.');
  }

  /** 같은 무전을 두 번 하지 않는다 */
  private sayOnce(key: string, who: string, text: string): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.ctx.hud.comm(who, text);
  }

  // ---------- 적 등장 ----------

  private pickSpawn(): Vector3 {
    // 관문이 닫혀 있는 동안은 북쪽(야드·관제동) 지점만, 열리면 남쪽 착륙장 지점도 쓴다. 너무 먼 지점(75m 밖)은 빼서 적이 금방 도착하게 한다
    const map = this.ctx.map;
    const spawns = map.gateOpen ? [...map.botSpawns, ...map.yardSpawns, ...map.blockSpawns] : [...map.yardSpawns, ...map.blockSpawns];
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

  /** 종류를 골라 하나를 대기열에 넣는다. pos를 주지 않으면 등장 지점은 그때 고른다 */
  private queueOne(delay: number, opts: BotOptions, pos?: Vector3): void {
    this.botCounter++;
    const label = opts.kind === 'rusher' ? '돌입병' : opts.kind === 'marksman' ? '저격병' : opts === HEAVY ? '중장병' : '돌격병';
    this.spawnQueue.push({ at: this.ctx.now + delay, name: `${label} ${this.botCounter}`, opts, pos });
    this.spawnQueue.sort((a, b) => a.at - b.at);
  }

  /** 살아 있는(또는 곧 나올) 저격병 수. 한 번에 하나만 둔다 */
  private get marksmen(): number {
    return this.ctx.bots.filter((b) => b.alive && b.def.kind === 'marksman').length + this.spawnQueue.filter((s) => s.opts.kind === 'marksman').length;
  }

  private spawn(name: string, opts: BotOptions, pos?: Vector3, alert = true): Bot {
    const bot = new Bot(this.ctx, name, pos ? pos.clone() : this.pickSpawn(), opts);
    this.ctx.bots.push(bot);
    this.ctx.scene.add(bot.group, bot.debugLine);
    bot.setDebug(this.ctx.debug);
    // 등장하자마자 플레이어 쪽으로 오게 한다(임무에서는 적이 목표 지점으로 몰려와야 한다). alert가 false면 순찰하다가 보면 싸운다
    if (alert) bot.hear(this.ctx.player.position);
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
    for (const r of this.openRelays) {
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
      const lights = this.relayStep === 1;
      const r = this.nearestOpenRelay();
      const doneNow = this.openRelays.filter((x) => x.done).length;
      if (r) {
        const res = this.hold(r.pos, r.progress, RELAY_HOLD, dt, lights ? '유도등 점등' : '봉쇄 해제');
        r.progress = res.progress;
        if (r.progress > 0 && !r.ambushed) {
          r.ambushed = true;
          if (lights) {
            // 유도등에 손대면 착륙장 수비대가 온다. 두 번째에는 돌입병이 섞인다
            this.queue(doneNow === 0 ? 2 : 1, 0.4);
            if (doneNow === 1) this.queueOne(1.2, RUSH);
            hud.killFeed('착륙장 수비대 접근', 'death');
          } else {
            // 보안 단말에 손대면 순찰하던 경비병이 위치를 알고 몰려온다(새로 나오지는 않는다)
            for (const b of ctx.bots) if (b.alive) b.hear(ctx.player.position);
            hud.killFeed('경보 — 경비병이 관제실로 온다', 'death');
          }
        }
        if (r.progress >= 1) {
          r.done = true;
          r.light.emissive.setHex(CYAN);
          const n = doneNow + 1;
          this.hooks.onScore(MISSION_SCORE.relay, lights ? `유도등 점등 ${n} / ${this.openRelays.length}` : '봉쇄 해제');
          if (lights && n < this.openRelays.length) hud.comm(SHIP, '하나 확인. 나머지 하나도 켜 줘.');
          ctx.sfx.waveClear();
        }
        markPos = r.pos;
        markLabel = lights ? '유도등' : '보안 단말';
      }
      if (lights) hud.setObjective(`목표: 착륙 유도등 켜기 ${doneNow} / ${this.openRelays.length}`, `남쪽 착륙장 · 남은 적 ${this.aliveBots}`);
      else hud.setObjective('목표: 관제동 봉쇄 해제', `관제실 보안 단말 · 남은 적 ${this.aliveBots}`);
      hud.setRest('');
      if (this.openRelays.every((x) => x.done)) {
        if (lights) {
          this.stage = 'extract';
          this.timerEnd = now + EXTRACT_SECONDS;
          this.zone.visible = true;
          this.queue(2, 1.0);
          hud.comm(SHIP, `유도등 확인, 내려간다. ${EXTRACT_SECONDS}초 안에 타!`);
          ctx.sfx.waveStart();
        } else {
          this.stage = 'upload';
          hud.comm(HQ, '봉쇄 해제 확인. 서버실로 가서 항로 기록을 전송해. 놈들이 화물을 빼돌린 증거다.');
        }
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
        hud.comm(HQ, '전송 시작. 놈들이 방 안에 들어오면 회선이 끊긴다. 방을 지켜.');
        ctx.sfx.waveStart();
      }
      if (inside && hostiles === 0) this.uploadProgress = Math.min(1, this.uploadProgress + dt / UPLOAD_SECONDS);
      if (this.uploadProgress >= 0.5) this.sayOnce('half', HQ, '절반 넘었다. 조금만 더 버텨.');
      // 다음 적은 플레이어가 서버실 안에 있는 동안에만 다가온다(죽어서 돌아오는 사이에 적이 쌓이지 않게)
      if (!inside) this.nextWaveAt += dt;
      if (this.uploadStarted && now >= this.nextWaveAt) {
        this.nextWaveAt = now + UPLOAD_WAVE_EVERY;
        this.waveCount++;
        // 무리 = 돌입병 하나 + 돌격병 하나(홀수 번째 무리는 돌입병만). 부활이 없으므로 한꺼번에 몰리지 않게 한다
        const n = Math.min(this.waveCount % 2 === 0 ? 2 : 1, UPLOAD_MAX_ALIVE - this.aliveBots);
        for (let i = 0; i < n; i++) {
          this.botCounter++;
          this.spawnQueue.push({
            at: now + 0.2 + i * 0.5, name: `${i === 0 ? '돌입병' : '돌격병'} ${this.botCounter}`,
            opts: i === 0 ? RUSH : {}, pos: this.pickBlockSpawn(),
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
        this.stage = 'carry';
        this.hooks.onScore(MISSION_SCORE.upload, '항로 기록 전송 완료');
        hud.comm(HQ, '기록 확보! 이제 널 빼낼 차례다. 그런데 야드의 신호기에 전원이 없어.');
        hud.comm(HQ, '단말 앞의 전원 셀을 들고 야드로 나와. 셀을 들고는 뛸 수 없다.');
        ctx.sfx.waveClear();
      }
    } else if (this.stage === 'carry') {
      const p = ctx.player;
      const c = this.held;
      if (c) {
        if (p.alive) {
          if (p.ctrl.onGround) c.ground.copy(p.position);
          if (!this.carrySprung && c === this.cells[0] && p.position.z > -120) {
            this.carrySprung = true;
            this.queue(1, 0.2);
            this.queueOne(0.2, MARKSMAN, YARD_MARKSMAN);
            hud.comm(HQ, '야드에 저격병이다. 조준선이 보이면 옆으로 움직이거나 엄폐물 뒤에 앉아.');
          }
          const d = this.tmp.copy(p.position).sub(BEACON_POS);
          if (Math.hypot(d.x, d.z) <= INTERACT_RADIUS && Math.abs(d.y) < 2.5) {
            c.delivered = true;
            this.setHeld(null);
            const n = this.cellsDelivered;
            this.hooks.onScore(MISSION_SCORE.cell, `전원 셀 장착 ${n} / ${this.cells.length}`);
            ctx.sfx.waveClear();
            const rest = this.nearestCell();
            if (rest) hud.comm(HQ, `하나로는 부족하다. ${rest.where}에 예비 셀이 있어.`);
            else {
              this.beaconLight?.emissive.setHex(AMBER);
              this.stage = 'beacon';
              hud.comm(HQ, '전원 들어왔다. 신호기를 켜서 제비를 불러.');
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
          if (!k.taken) {
            k.taken = true;
            if (k === this.cells[0]) {
              CELL_GUARDS.forEach((pos, i) => {
                this.botCounter++;
                this.spawnQueue.push({ at: now + 0.6 + i * 0.4, name: `경비병 ${this.botCounter}`, opts: {}, pos });
              });
              this.spawnQueue.sort((a, b) => a.at - b.at);
              hud.killFeed('전원 셀 확보 — 로비에 경비병', 'death');
            } else {
              this.queue(1, 0.3);
              this.queueOne(1.3, RUSH);
              hud.comm(ME, '두 번째 셀 확보. 신호기로 돌아간다.');
            }
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
        this.stage = 'defend';
        this.timerEnd = now + DEFEND_SECONDS;
        this.nextWaveAt = now + 1;
        this.hooks.onScore(MISSION_SCORE.beacon, '탈출선 호출');
        hud.comm(SHIP, `여기는 제비. 스카이독으로 간다. ${DEFEND_SECONDS}초만 버텨라.`);
        ctx.sfx.waveStart();
      }
    } else if (this.stage === 'defend') {
      if (now >= this.nextWaveAt) {
        this.nextWaveAt = now + DEFEND_WAVE_EVERY;
        this.waveCount++;
        const room = DEFEND_MAX_ALIVE - this.aliveBots;
        if (room > 0) {
          // 무리마다 하나는 다른 종류: 돌입병 → 저격병(하나만) → 중장병 순으로 돌아간다
          const turn = this.waveCount % 3;
          const special = room >= 2 ? (turn === 0 ? HEAVY : turn === 2 && this.marksmen === 0 ? MARKSMAN : RUSH) : null;
          this.queue(Math.min(2, room) - (special ? 1 : 0), 0.2);
          if (special) this.queueOne(0.7, special);
        }
      }
      if (this.timeLeft <= 30) this.sayOnce('eta', SHIP, '진입 중이다. 30초.');
      hud.setObjective('목표: 탈출선이 올 때까지 방어', `남은 적 ${this.aliveBots}`);
      hud.setRest(`탈출선 도착까지 ${Math.ceil(this.timeLeft)}초`);
      if (now >= this.timerEnd) {
        this.stage = 'boss';
        this.hooks.onScore(MISSION_SCORE.defend, '방어 성공');
        this.spawnQueue.push({ at: now + 0.8, name: '추적자', opts: BOSS });
        this.queue(1, 1.4);
        hud.comm(HQ, '큰 놈이 온다. 아르고스의 추적자다. 저놈이 살아 있으면 제비가 못 내려.');
        ctx.sfx.waveStart();
      }
    } else if (this.stage === 'boss') {
      hud.setObjective('목표: 추적자 처치', `남은 적 ${this.aliveBots}`);
      hud.setRest('');
      if (this.boss) {
        hud.setBoss(this.boss.alive ? { name: this.boss.displayName, hp: this.boss.hp, max: this.boss.maxHp } : null);
        if (!this.boss.alive) {
          this.boss = null;
          // 추적자의 인증키로 남쪽 관문이 열린다. 착륙장에서 유도등 둘을 켜야 제비가 내린다
          this.hooks.setGate(true);
          this.relayStep = 1;
          this.openRelays = [this.relays[0], this.relays[1]];
          this.stage = 'relays';
          this.queue(1, 1.0);
          this.queueOne(0.6, MARKSMAN, GATE_MARKSMAN);
          hud.comm(HQ, '추적자 제압. 놈의 인증키로 남쪽 관문을 열었다. 통로를 지나 착륙장으로.');
          hud.comm(SHIP, '착륙장 유도등이 꺼져 있다. 두 기 다 켜 줘. 관문 너머에 저격병이 있다.');
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
        this.hooks.onDefeat('제비는 더 기다릴 수 없었다');
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

import {
  AdditiveBlending, BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, TorusGeometry, Vector3,
} from 'three';
import { Bot, type BotOptions } from '@/entities/Bot';
import type { GameContext } from '@/core/Context';
import { losBlocked } from '@/combat/Hitscan';

export type MissionStage =
  | 'idle' | 'intel' | 'radio' | 'upload' | 'unlock' | 'yard' | 'carry' | 'beacon' | 'defend' | 'boss' | 'gate' | 'lights' | 'extract' | 'done' | 'failed';

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
  setDoor(open: boolean): void;
}

/** 임무 '탈출'의 수치. 안에서 밖으로: 관제동(실내, 시작) → 북쪽 야드 → 화물 통로 → 관문 → 남쪽 착륙장 */
/** 임무 시작 자리: 관제동 로비, 닫힌 정문 바로 안쪽(북쪽을 본다) */
export const MISSION_START = new Vector3(0, 0, -125.5);
/** 단말 셋. 0·1 = 남쪽 착륙장의 유도등(마지막에 켠다), 2 = 관제실의 보안 단말(처음에 접속하고, 나중에 봉쇄를 푼다) */
const RELAY_SPOTS = [new Vector3(-32, 0, 18), new Vector3(32, 0, -18), new Vector3(0, 0, -162)];
const SECURITY = 2;
/** 관문이 열린 뒤 착륙장 쪽에서 통로를 겨누는 저격병 */
const GATE_MARKSMAN = new Vector3(4, 0, -13);
/** 관문 바로 남쪽(착륙장 들머리) */
const PAD_ENTRY = new Vector3(0, 0, -24);
const BEACON_POS = new Vector3(0, 0, -95);
const EXTRACT_POS = new Vector3(0, 0, 26);
const INTERACT_RADIUS = 2.6;
const RELAY_HOLD = 2.5;
const UNLOCK_HOLD = 3.0;
const UPLINK_HOLD = 2.0;
const BEACON_HOLD = 2.0;
const DEFEND_SECONDS = 70;
/** 제비와의 교신이 끝난 뒤에 첫 무리가 온다 */
const DEFEND_FIRST_WAVE = 10;
const DEFEND_WAVE_EVERY = 13;
const DEFEND_MAX_ALIVE = 3;
const EXTRACT_SECONDS = 45;
const EXTRACT_RADIUS = 3;
/** 자료 전송(거점 유지): 관제동 서버실 안. 플레이어가 안에 있고 살아 있는 적이 안에 없을 때만 진행된다 */
const UPLOAD_CENTER = new Vector3(0, 0, -145);
const UPLOAD_HALF_X = 8.0;
const UPLOAD_Z0 = -153.0;
const UPLOAD_Z1 = -137.0;
const UPLOAD_SECONDS = 48;
/** 전송이 이만큼 진행되면 경보가 울린다(그 전까지는 적이 없다: 약 17초) */
const ALARM_AT = 0.36;
/** 경보가 울리고 첫 경비병이 나올 때까지(초) */
const ALARM_GRACE = 6;
const UPLOAD_WAVE_EVERY = 11;
const UPLOAD_MAX_ALIVE = 3;
const TERMINAL_POS = new Vector3(-2.6, 0, -152.3);
/** 전원 셀 운반: 신호기에 전원이 없다. 셀 둘(야드 서쪽 하역장 위, 화물 통로)을 신호기로 옮긴다. 들고 있는 동안은 달릴 수 없다 */
const CELL_SPOTS: { pos: Vector3; where: string }[] = [
  { pos: new Vector3(-26, 1.35, -95.5), where: '서쪽 하역장' },
  { pos: new Vector3(5.5, 0, -51.5), where: '남쪽 화물 통로' },
];
const CELL_PICKUP = 1.5;
/** 돌입병: 멀리서 쏘지 않고 3~6m까지 파고든다(서버실 거점을 실제로 빼앗으러 들어온다). 저격병: 멀리서 조준선을 비추고 한 발 */
const RUSH: BotOptions = { kind: 'rusher' };
const MARKSMAN: BotOptions = { kind: 'marksman' };
const AMBER = 0xffb030;
const HEAVY: BotOptions = { hpMult: 1.8, scale: 1.15 };
const BOSS: BotOptions = { hpMult: 3, scale: 1.35, boss: true };
export const MISSION_SCORE = { intel: 100, relay: 200, upload: 300, cell: 150, beacon: 200, defend: 400, extract: 500 };
/** 탈출선이 내려오는 데 걸리는 시간(초)과 떠 있는 높이(선체 바닥, m) */
const SHIP_ARRIVE = 7;
const SHIP_HOVER = 4.6;

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
 * 정찰 요원 레이븐은 증거(항로 기록)를 찾아 관제동에 숨어들었다. 본부 '등대'의 안내로 기록을 전송하다가 들키고,
 * 봉쇄를 풀고 나와 탈출선 '제비'를 불러 착륙장에서 빠져나간다.
 *
 * 진행은 네 막이다. 처음 1분 남짓은 적이 없다(걸으며 무전을 듣는다). 적은 '무슨 일이 일어난 뒤에' 나온다.
 *
 *   1막 잠입: 로비 → 관제실 보안 단말 접속(F) → [무전] → 서버실 전송 단말에서 회선 열기(F) → 조용히 전송(36%까지)
 *   2막 발각: 경보(붉은 조명) → 서버실 방어(전송 100%) → [무전] → 관제실 보안 단말로 봉쇄 해제(F, 경비병) → 정문 열림
 *   3막 신호: 조용한 야드 → 신호기 확인 → [무전] → 전원 셀 2개 운반(저격병 등장) → 제비 호출(F) → 70초 방어 → 추적자
 *   4막 탈출: 남쪽 관문 열림 → 화물 통로 → 착륙장 유도등 2기(F) → 제비 착륙 → 45초 안에 탑승
 *
 * [무전]은 대사가 끝날 때까지 다음 목표가 뜨지 않는 구간이다(stage 'radio'). 대사는 시뮬레이션 시간으로 흐른다.
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
  /** 무전 대사 대기열. 시뮬레이션 시간으로 흐른다(일시정지하면 대사도 멈춘다) */
  private lines: { who: string; text: string; hint: boolean }[] = [];
  private lineEnd = 0;
  private lineShown = false;
  /** 예약한 일: 시각이 되고(quiet면 무전까지 끝나고) 나서 실행한다 */
  private script: { at: number; quiet: boolean; fn: () => void }[] = [];
  /** 'radio' 단계에서 목표 자리에 띄우는 글 */
  private radioText = '';
  private uplinkHold = 0;
  private alarmed = false;
  private cellsTaken = 0;
  /** 탈출선 '제비'. shipAt = 내려오기 시작한 시각(-1이면 아직 오지 않았다) */
  private readonly ship = new Group();
  private shipAt = -1;
  private lastSpawn: Vector3 | null = null;
  /** 한 번만 나오는 무전을 이미 했는가 */
  private readonly said = new Set<string>();
  /** 서버실 거점 표시(바닥 테두리 + 전송 단말) */
  private readonly uplink = new Group();
  private uplinkEdge: MeshStandardMaterial | null = null;
  private uplinkLight: MeshStandardMaterial | null = null;
  private uploadProgress = 0;
  private uploadStarted = false;
  /** 전원 셀 둘. 바닥에 놓여 있을 때만 보인다 */
  private cells: Cell[] = [];
  private held: Cell | null = null;
  /** 들고 있는 셀의 모습. 3인칭 몸의 등(torso 뼈)에 붙인다 */
  private readonly carried = new Group();
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

    // 탈출선 '제비': 맵 키트에 생성 모델(kit_ship, 원점 = 선체 바닥 가운데, 기수 +Z)이 있으면 그것을, 없으면 상자 몇 개로 만든다
    const kitShip = this.ctx.assets?.mapKit?.getObjectByName('kit_ship') ?? null;
    if (kitShip) {
      const model = kitShip.clone(true);
      model.position.set(0, 0, 0);
      model.traverse((o) => {
        o.castShadow = true;
      });
      this.ship.add(model);
    } else {
      const hull = new MeshStandardMaterial({ color: 0xd8dde4, roughness: 0.6, metalness: 0.3 });
      const glow = new MeshStandardMaterial({ color: 0x062028, emissive: CYAN, emissiveIntensity: 2.4 });
      const body = new Mesh(new BoxGeometry(3.2, 2.2, 9), hull);
      body.position.y = 1.3;
      const wing = new Mesh(new BoxGeometry(11, 0.3, 2.6), hull);
      wing.position.set(0, 2.2, -0.5);
      for (const x of [-5.5, 5.5]) {
        const pod = new Mesh(new CylinderGeometry(0.8, 0.8, 1.4, 14), hull);
        pod.position.set(x, 1.9, -0.5);
        const jet = new Mesh(new CylinderGeometry(0.6, 0.6, 0.1, 14), glow);
        jet.position.set(x, 1.15, -0.5);
        pod.castShadow = true;
        this.ship.add(pod, jet);
      }
      body.castShadow = true;
      wing.castShadow = true;
      this.ship.add(body, wing);
    }
    this.ship.visible = false;
    this.ctx.scene.add(this.ship);
  }

  private setVisible(v: boolean): void {
    for (const r of this.relays) r.group.visible = v;
    this.beacon.visible = v;
    this.zone.visible = false;
    this.ship.visible = false;
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
    this.hooks.setDoor(false);
    this.ctx.map.setAlarm(false);
    this.said.clear();
    this.lines = [];
    this.lineEnd = 0;
    this.lineShown = false;
    this.script = [];
    this.radioText = '';
    this.uploadProgress = 0;
    this.uploadStarted = false;
    this.uplinkHold = 0;
    this.alarmed = false;
    this.uplinkLight?.emissive.setHex(RED);
    this.uplinkEdge?.emissive.setHex(CYAN);
    if (this.uplinkEdge) this.uplinkEdge.emissiveIntensity = 0.9;
    this.setHeld(null);
    for (const c of this.cells) {
      c.ground.copy(c.spot);
      c.taken = false;
      c.delivered = false;
    }
    this.cellsTaken = 0;
    this.shipAt = -1;
    this.lastSpawn = null;
    this.stage = 'intel';
    const hud = this.ctx.hud;
    hud.setBoss(null);
    hud.setRest('');
    hud.setComm(null);
    // 1막: 적이 없다. 걸어 들어가며 무전을 듣는다
    hud.chapter('1막 · 잠입', '스카이독 관제동');
    this.after(1.5, () => {
      this.say(HQ, '레이븐, 들리나. 관제동 안이다. 아직 아무도 널 모른다.');
      this.say(HQ, '아르고스가 화물 항로를 고쳐 쓴 기록이 이 건물에 있다. 북쪽 끝 관제실의 보안 단말부터 찾아.');
    });
  }

  // ---------- 무전·연출 ----------

  /** 무전 한 줄을 대기열에 넣는다. urgent면 지금 나오는 줄을 끊고 바로 나온다(경고) */
  private say(who: string, text: string, urgent = false, hint = false): void {
    if (urgent) {
      this.lines.unshift({ who, text, hint });
      this.lineEnd = Math.min(this.lineEnd, this.ctx.now);
    } else this.lines.push({ who, text, hint });
  }

  private skipHints(): void {
    this.lines = this.lines.filter((l) => !l.hint);
  }

  /** 같은 무전을 두 번 하지 않는다 */
  private sayOnce(key: string, who: string, text: string, hint = false): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.say(who, text, false, hint);
  }

  /** 밀린 대사를 버리고 지금 나오는 줄도 끊는다(상황이 바뀌어 앞의 말이 뒤늦은 말이 될 때) */
  private cut(): void {
    this.lines.length = 0;
    this.lineEnd = Math.min(this.lineEnd, this.ctx.now);
  }

  /** 무전이 나오는 중이거나 밀려 있는가 */
  get talking(): boolean {
    return this.lines.length > 0 || this.ctx.now < this.lineEnd;
  }

  private updateTalk(): void {
    const now = this.ctx.now;
    if (now < this.lineEnd) return;
    const l = this.lines.shift();
    if (!l) {
      if (this.lineShown) {
        this.ctx.hud.setComm(null);
        this.lineShown = false;
      }
      return;
    }
    this.ctx.hud.setComm(l.who, l.text);
    this.ctx.sfx.radio();
    this.lineShown = true;
    // 한 줄에 글자 수에 따라 3.2~6.2초
    this.lineEnd = now + Math.max(3.2, Math.min(6.2, 1.5 + l.text.length * 0.085));
  }

  /** delay초 뒤에(quiet면 무전까지 끝난 뒤에) 실행한다 */
  private after(delay: number, fn: () => void, quiet = false): void {
    this.script.push({ at: this.ctx.now + delay, quiet, fn });
  }

  private runScript(): void {
    const now = this.ctx.now;
    for (let i = 0; i < this.script.length;) {
      const s = this.script[i];
      if (now >= s.at && (!s.quiet || !this.talking)) {
        this.script.splice(i, 1);
        s.fn();
      } else i++;
    }
  }

  /** 무전 구간: 대사가 끝날 때까지 다음 목표를 띄우지 않는다. 끝나면 next */
  private radio(text: string, next: () => void): void {
    this.stage = 'radio';
    this.radioText = text;
    this.after(0.8, () => {
      if (this.stage === 'radio') next();
    }, true);
  }

  /** 탈출선이 남쪽 하늘에서 내려와 탈출 지점 위에 뜬다 */
  private updateShip(): void {
    if (this.shipAt < 0) return;
    const now = this.ctx.now;
    const u = Math.min(1, (now - this.shipAt) / SHIP_ARRIVE);
    const e = 1 - Math.pow(1 - u, 3);
    const far = 1 - e;
    this.ship.position.set(EXTRACT_POS.x + far * 26, SHIP_HOVER + far * 34 + Math.sin(now * 1.7) * 0.12 * e, EXTRACT_POS.z + far * 70);
    // 기수를 북쪽(달려오는 플레이어 쪽)으로. 들어오는 동안은 진행 방향으로 틀고 기울인다
    this.ship.rotation.set(0, Math.PI + far * 0.36, far * 0.3 + Math.sin(now * 1.1) * 0.015);
  }

  // ---------- 적 등장 ----------
  // ---------- 적 등장 ----------

  /** 등장 지점 하나. 플레이어 눈에 보이지 않고 minDist 넘게 떨어진 곳을 먼저 고른다(눈앞에서 불쑥 나타나지 않게) */
  private pickHidden(spawns: Vector3[], minDist: number): Vector3 {
    const p = this.ctx.player.position;
    const eye = new Vector3(p.x, p.y + 1.6, p.z);
    const all = spawns.map((s) => ({ s, d: s.distanceTo(p) }));
    const apart = all.filter((c) => c.s !== this.lastSpawn && c.d >= minDist && c.d <= 80);
    const hidden = apart.filter((c) => losBlocked(eye, new Vector3(c.s.x, c.s.y + 1.2, c.s.z), this.ctx.map.meshes));
    const pool = hidden.length ? hidden : apart.length ? apart : all;
    const c = pool[Math.floor(Math.random() * pool.length)];
    this.lastSpawn = c.s;
    return c.s.clone().add(new Vector3((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5));
  }

  private pickSpawn(): Vector3 {
    // 정문이 닫혀 있으면 관제동 안에서만, 관문이 닫혀 있으면 북쪽(야드·관제동)에서, 관문이 열리면 착륙장과 야드에서 나온다
    const map = this.ctx.map;
    if (!map.doorOpen) return this.pickHidden(map.blockSpawns, 10);
    return this.pickHidden(map.gateOpen ? [...map.botSpawns, ...map.yardSpawns] : [...map.yardSpawns, ...map.blockSpawns], 22);
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

  /** 아직 켜지 않은 유도등 중 가까운 것 */
  private nearestLight(): Relay | null {
    const p = this.ctx.player.position;
    let best: Relay | null = null;
    let bd = Infinity;
    for (const r of [this.relays[0], this.relays[1]]) {
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

  /** 현재 목표 지점. 없으면(무전·방어·보스) null */
  goal(): MissionGoal | null {
    const at = (pos: Vector3, interact: boolean, radius = INTERACT_RADIUS, urgent = false): MissionGoal => ({ pos, interact, urgent, radius });
    switch (this.stage) {
      case 'intel':
      case 'unlock':
        return at(this.relays[SECURITY].pos, true);
      case 'upload':
        return this.uploadStarted ? at(UPLOAD_CENTER, false, 3) : at(TERMINAL_POS, true);
      case 'yard':
        return at(BEACON_POS, false);
      case 'carry': {
        if (this.held) return at(BEACON_POS, false);
        const c = this.nearestCell();
        return c ? at(c.ground, false, 1) : null;
      }
      case 'beacon':
        return at(BEACON_POS, true);
      case 'gate':
        return at(PAD_ENTRY, false, 4);
      case 'lights': {
        const r = this.nearestLight();
        return r ? at(r.pos, true) : null;
      }
      case 'extract':
        return at(EXTRACT_POS, false, EXTRACT_RADIUS, true);
      default:
        return null;
    }
  }

  /** 경보가 울린다: 조명이 붉어지고, 잠시 뒤 첫 경비병이 온다 */
  private tripAlarm(): void {
    const ctx = this.ctx;
    this.alarmed = true;
    ctx.map.setAlarm(true);
    ctx.sfx.alarm();
    ctx.hud.chapter('2막 · 발각', '경보 — 관제동 봉쇄');
    this.cut();
    this.say(HQ, '젠장, 저장소에 감시 장치가 물려 있었다. 경보다!');
    this.say(HQ, '전송은 못 멈춘다. 놈들이 방 안에 들어오면 회선이 끊겨. 문 쪽을 봐.');
    this.nextWaveAt = ctx.now + ALARM_GRACE;
    this.waveCount = 0;
  }

  update(dt: number): void {
    this.ctx.map.tick(dt, this.ctx.now);
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
    this.runScript();
    this.updateTalk();
    this.updateShip();
    hud.setInteract(null);
    let markPos: Vector3 | null = null;
    let markLabel = '';
    // 관제동 안의 표시물은 관제동이 그려질 때만 그린다(Game.frame의 setBlockVisible과 같은 기준)
    const north = ctx.camera.position.z < -32;
    this.uplink.visible = north;
    this.relays[SECURITY].group.visible = north;
    const p = ctx.player;
    const sec = this.relays[SECURITY];
    const foes = this.aliveBots ? ` · 남은 적 ${this.aliveBots}` : '';

    if (this.stage === 'intel') {
      // 1막: 로비 → 옆방 → 관제실. 걷는 동안 무전이 이어진다. 적은 없다
      if (p.position.z < -138.5) {
        this.sayOnce('in1', ME, '안쪽으로 들어왔다. 경비가 하나도 없다.');
        this.sayOnce('in2', HQ, '교대 시간이다. 운이 아니라 내가 시간을 맞춘 거야. 그래도 오래는 못 간다.');
      }
      if (p.position.z < -154.5) this.sayOnce('in3', HQ, '큰 화면 아래의 단말이다. F를 길게 눌러 접속해.', true);
      sec.progress = this.hold(sec.pos, sec.progress, RELAY_HOLD, dt, '보안 단말 접속').progress;
      markPos = sec.pos;
      markLabel = '보안 단말';
      hud.setObjective('목표: 항로 기록 찾기', '관제실 보안 단말에 접속');
      hud.setRest('');
      if (sec.progress >= 1) {
        sec.progress = 0;
        sec.light.emissive.setHex(AMBER);
        this.hooks.onScore(MISSION_SCORE.intel, '보안 단말 접속');
        ctx.sfx.heal();
        this.skipHints();
        this.say(ME, '접속했다. …항로 기록은 여기 없다. 서버실 주 저장소에 잠겨 있어.');
        this.say(HQ, '그럼 통째로 받아 온다. 서버실 전송 단말에서 회선을 열어. 내가 받는다.');
        this.radio('등대와 교신 중', () => {
          this.stage = 'upload';
        });
      }
    } else if (this.stage === 'radio') {
      hud.setObjective(this.radioText, foes ? foes.slice(3) : '');
      hud.setRest('');
    } else if (this.stage === 'upload') {
      const inside = p.alive && inUploadRoom(p.position);
      let hostiles = 0;
      for (const b of ctx.bots) if (b.alive && inUploadRoom(b.position)) hostiles++;
      if (!this.uploadStarted) {
        this.uplinkHold = this.hold(TERMINAL_POS, this.uplinkHold, UPLINK_HOLD, dt, '전송 회선 열기').progress;
        markPos = TERMINAL_POS;
        markLabel = '전송 단말';
        hud.setObjective('목표: 항로 기록 전송', '서버실 전송 단말에서 회선 열기');
        if (this.uplinkHold >= 1) {
          this.uploadStarted = true;
          this.uplinkLight?.emissive.setHex(AMBER);
          ctx.sfx.heal();
          this.say(HQ, '회선 연결. 받는 중이다. 방에서 나가지 마, 신호가 약하다.');
        }
      } else {
        if (inside && hostiles === 0) this.uploadProgress = Math.min(1, this.uploadProgress + dt / UPLOAD_SECONDS);
        const u = this.uploadProgress;
        // 조용한 구간: 등대가 기록을 읽는다. 경보는 그 뒤에 울린다
        if (u >= 0.08) this.sayOnce('up1', HQ, '…레이븐, 이건 항로를 고친 정도가 아니다. 구호 물자 선적분이 여섯 달째 통째로 사라졌어.');
        if (u >= 0.2) {
          this.sayOnce('up2', ME, '어디로 빼돌렸는지는?');
          this.sayOnce('up3', HQ, '그게 이 기록에 있다. 끝까지 받아야 해.');
        }
        if (u >= ALARM_AT && !this.alarmed) this.tripAlarm();
        if (u >= 0.68) this.sayOnce('half', HQ, '삼분의 이. 조금만 더 버텨.');
        if (this.alarmed) {
          // 다음 적은 플레이어가 서버실 안에 있는 동안에만 다가온다
          if (!inside) this.nextWaveAt += dt;
          if (now >= this.nextWaveAt) {
            this.nextWaveAt = now + UPLOAD_WAVE_EVERY;
            this.waveCount++;
            // 첫 무리는 경비병 둘. 그 뒤로는 돌입병 하나, 돌입병 + 돌격병이 번갈아 온다(동시에 셋까지)
            const first = this.waveCount === 1;
            const n = Math.min(first || this.waveCount % 2 === 1 ? 2 : 1, UPLOAD_MAX_ALIVE - this.aliveBots);
            for (let i = 0; i < n; i++) {
              this.botCounter++;
              const rush = !first && i === 0;
              this.spawnQueue.push({
                at: now + 0.2 + i * 0.6, name: `${first ? '경비병' : rush ? '돌입병' : '돌격병'} ${this.botCounter}`,
                opts: rush ? RUSH : {}, pos: this.pickHidden(ctx.map.blockSpawns, 10),
              });
            }
            this.spawnQueue.sort((a, b) => a.at - b.at);
            if (first) this.say(HQ, '발소리다. 온다!', true);
          }
        }
        if (this.uplinkEdge) {
          this.uplinkEdge.emissive.setHex(hostiles ? RED : CYAN);
          this.uplinkEdge.emissiveIntensity = inside && !hostiles ? 1.7 : 0.9;
        }
        if (inside) hud.setInteract(hostiles ? '전송 중단 — 서버실 안의 적을 처치' : '항로 기록 전송 중', u);
        else {
          markPos = UPLOAD_CENTER;
          markLabel = '서버실';
        }
        hud.setObjective(`목표: 항로 기록 전송 ${Math.floor(u * 100)}%`,
          `${inside ? (this.alarmed ? '서버실을 지켜라' : '서버실 안에서 기다려라') : '서버실로 돌아가라'}${foes}`);
        if (u >= 1) {
          this.uplinkLight?.emissive.setHex(CYAN);
          if (this.uplinkEdge) {
            this.uplinkEdge.emissive.setHex(CYAN);
            this.uplinkEdge.emissiveIntensity = 0.5;
          }
          this.hooks.onScore(MISSION_SCORE.upload, '항로 기록 전송 완료');
          ctx.sfx.waveClear();
          this.cut();
          this.say(HQ, '전부 받았다. 이걸로 아르고스는 끝이야. 이제 널 빼낼 차례다.');
          this.say(HQ, '문제가 하나 있다. 경보와 함께 관제동이 봉쇄됐어. 정문이 내 쪽에서는 안 열린다.');
          this.say(HQ, '관제실 보안 단말로 돌아가. 아까 그 단말에서 직접 풀어야 해.');
          this.radio('등대와 교신 중', () => {
            this.stage = 'unlock';
          });
        }
      }
      hud.setRest('');
    } else if (this.stage === 'unlock') {
      sec.progress = this.hold(sec.pos, sec.progress, UNLOCK_HOLD, dt, '봉쇄 해제').progress;
      if (sec.progress > 0 && !sec.ambushed) {
        // 단말에 손대면 위치가 드러난다: 돌격병 하나, 돌입병 하나
        sec.ambushed = true;
        this.botCounter++;
        this.spawnQueue.push({ at: now + 1.0, name: `돌격병 ${this.botCounter}`, opts: {}, pos: this.pickHidden(ctx.map.blockSpawns, 10) });
        this.botCounter++;
        this.spawnQueue.push({ at: now + 1.8, name: `돌입병 ${this.botCounter}`, opts: RUSH, pos: this.pickHidden(ctx.map.blockSpawns, 10) });
        this.spawnQueue.sort((a, b) => a.at - b.at);
        this.say(HQ, '단말에 손댄 걸 놈들도 안다. 온다!', true);
      }
      markPos = sec.pos;
      markLabel = '보안 단말';
      hud.setObjective('목표: 관제동 봉쇄 해제', `관제실 보안 단말${foes}`);
      hud.setRest('');
      if (sec.progress >= 1) {
        sec.done = true;
        sec.light.emissive.setHex(CYAN);
        this.hooks.setDoor(true);
        ctx.sfx.door();
        this.hooks.onScore(MISSION_SCORE.relay, '봉쇄 해제');
        this.cut();
        this.say(HQ, '봉쇄 해제. 정문이 열렸다. 로비를 지나 야드로 나와.');
        this.stage = 'yard';
      }
    } else if (this.stage === 'yard') {
      // 3막의 들머리: 야드는 비어 있다. 신호기까지 걸어가며 무전을 듣는다
      const out = p.position.z > -120.5;
      if (out && !this.said.has('out1')) {
        hud.chapter('3막 · 신호', '북쪽 야드');
        this.sayOnce('out1', ME, '밖이다. 야드에 아무도 없다.');
        this.sayOnce('out2', HQ, '경비 병력이 전부 관제동으로 몰려갔다. 지금이 기회야.');
        this.sayOnce('out3', HQ, '야드 한가운데에 비상 신호기가 있다. 그걸로 탈출선 제비를 부른다.');
      }
      markPos = BEACON_POS;
      markLabel = '신호기';
      hud.setObjective('목표: 비상 신호기 확인', `${out ? '야드 한가운데' : '정문을 지나 야드로'}${foes}`);
      hud.setRest('');
      const d = this.tmp.copy(p.position).sub(BEACON_POS);
      if (p.alive && Math.hypot(d.x, d.z) <= INTERACT_RADIUS) {
        this.say(ME, '신호기 도착. …꺼져 있다. 전원이 없어.');
        this.say(HQ, '아르고스가 셀을 빼 뒀군. 전원 셀 두 개가 필요하다.');
        this.say(HQ, '서쪽 하역장 위에 하나, 남쪽 화물 통로에 하나. 표시해 줄게.');
        this.radio('등대와 교신 중', () => {
          this.stage = 'carry';
        });
      }
    } else if (this.stage === 'carry') {
      const c = this.held;
      if (c) {
        if (p.alive) {
          if (p.ctrl.onGround) c.ground.copy(p.position);
          const d = this.tmp.copy(p.position).sub(BEACON_POS);
          if (Math.hypot(d.x, d.z) <= INTERACT_RADIUS && Math.abs(d.y) < 2.5) {
            c.delivered = true;
            this.setHeld(null);
            const n = this.cellsDelivered;
            this.hooks.onScore(MISSION_SCORE.cell, `전원 셀 장착 ${n} / ${this.cells.length}`);
            ctx.sfx.waveClear();
            const rest = this.nearestCell();
            if (rest) this.say(HQ, `하나 장착. ${rest.where}에 하나 더 있다.`);
            else {
              this.beaconLight?.emissive.setHex(AMBER);
              this.stage = 'beacon';
              this.say(HQ, '전원이 들어왔다. 신호기를 켜서 제비를 불러.');
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
            this.cellsTaken++;
            if (this.cellsTaken === 1) {
              // 첫 셀: 몇 걸음 옮긴 뒤에 저격병이 자리를 잡는다(경고가 먼저 나온다)
              this.say(HQ, '셀을 들고는 뛸 수 없다. 엄폐물을 따라 천천히 움직여.');
              this.after(5, () => {
                this.queueOne(0, MARKSMAN);
                this.queue(1, 3);
                this.say(HQ, '저격병이 자리를 잡았다. 조준선이 보이면 옆으로 움직이거나 엄폐물 뒤에 앉아.', true);
              });
            } else {
              this.say(ME, '두 번째 셀 확보. 신호기로 돌아간다.');
              this.after(3, () => {
                this.queue(1, 0);
                this.queueOne(1.2, RUSH);
              });
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
          `${this.held ? '야드 한가운데 신호기로' : next ? `${next.where}의 셀을 집어라` : ''}${foes}`);
        hud.setRest(this.held ? '전원 셀 운반 중 · 달리기 불가' : '');
      } else hud.setRest('');
    } else if (this.stage === 'beacon') {
      const res = this.hold(BEACON_POS, this.beaconProgress, BEACON_HOLD, dt, '탈출선 호출');
      this.beaconProgress = res.progress;
      markPos = BEACON_POS;
      markLabel = '신호기';
      hud.setObjective('목표: 탈출선 호출', `야드 한가운데 신호기${foes}`);
      if (this.beaconProgress >= 1) {
        this.beaconLight?.emissive.setHex(CYAN);
        this.stage = 'defend';
        this.timerEnd = now + DEFEND_SECONDS;
        this.nextWaveAt = now + DEFEND_FIRST_WAVE;
        this.waveCount = 0;
        this.hooks.onScore(MISSION_SCORE.beacon, '탈출선 호출');
        ctx.sfx.waveStart();
        this.cut();
        this.say(SHIP, '여기는 제비. 신호 잡았다. 레이븐, 아직 살아 있었네?');
        this.say(ME, '늦지나 마.');
        this.say(SHIP, `${DEFEND_SECONDS}초면 간다. 그런데 그 신호, 아르고스도 다 봤을 거야. 손님 맞을 준비 해.`);
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
        if (this.waveCount === 1) this.say(HQ, '야드로 병력이 온다. 신호기 근처 엄폐물을 써.', true);
      }
      if (this.timeLeft <= 30) this.sayOnce('eta', SHIP, '스카이독이 보인다. 30초.');
      hud.setObjective('목표: 탈출선이 올 때까지 버티기', foes ? foes.slice(3) : '적이 오고 있다');
      hud.setRest(`탈출선 도착까지 ${Math.ceil(this.timeLeft)}초`);
      if (now >= this.timerEnd) {
        this.stage = 'boss';
        this.hooks.onScore(MISSION_SCORE.defend, '방어 성공');
        this.cut();
        this.say(SHIP, '잠깐, 못 내린다! 대공 조준이 걸렸어. 누가 날 겨누고 있다.');
        this.say(HQ, '추적자다. 아르고스의 사냥개. 저놈이 서 있는 한 제비는 못 내려온다. 쓰러뜨려.');
        // 대사가 먼저, 추적자는 그 뒤에 나온다
        this.spawnQueue.push({ at: now + 4.5, name: '추적자', opts: BOSS });
        this.queue(1, 7);
        ctx.sfx.waveStart();
      }
    } else if (this.stage === 'boss') {
      hud.setObjective('목표: 추적자 처치', foes ? foes.slice(3) : '');
      hud.setRest('');
      if (this.boss) {
        hud.setBoss(this.boss.alive ? { name: this.boss.displayName, hp: this.boss.hp, max: this.boss.maxHp } : null);
        if (!this.boss.alive) {
          this.boss = null;
          ctx.sfx.waveClear();
          this.cut();
          this.say(HQ, '추적자 제압. …놈이 관문 인증키를 갖고 있었다. 남쪽 관문을 연다.');
          this.say(SHIP, '야드는 좁아서 못 내린다. 관문 너머 남쪽 착륙장에서 보자.');
          // 4막: 관문은 대사 뒤에 열린다. 통로에 들어설 때까지는 적이 없다
          this.after(3.5, () => {
            this.hooks.setGate(true);
            ctx.sfx.door();
            hud.chapter('4막 · 탈출', '화물 통로 → 남쪽 착륙장');
          });
          this.stage = 'gate';
        }
      }
    } else if (this.stage === 'gate') {
      const z = p.position.z;
      if (ctx.map.gateOpen && z > -62 && !this.said.has('gm')) {
        this.said.add('gm');
        this.queueOne(0.3, MARKSMAN, GATE_MARKSMAN);
        this.queue(1, 3);
        this.say(SHIP, '관문 너머에 저격병이 보인다. 통로에서는 엄폐물 사이로 움직여.', true);
      }
      markPos = PAD_ENTRY;
      markLabel = '착륙장';
      hud.setObjective('목표: 남쪽 착륙장으로', `${ctx.map.gateOpen ? '화물 통로를 지나 관문 너머' : '남쪽 관문이 열리는 중'}${foes}`);
      hud.setRest('');
      if (z > -29) {
        this.stage = 'lights';
        this.cut();
        this.say(SHIP, '착륙장 유도등이 꺼져 있다. 맨눈으로는 못 내려. 두 기 다 켜 줘.');
      }
    } else if (this.stage === 'lights') {
      const lights = [this.relays[0], this.relays[1]];
      const r = this.nearestLight();
      const doneNow = lights.filter((x) => x.done).length;
      if (r) {
        r.progress = this.hold(r.pos, r.progress, RELAY_HOLD, dt, '유도등 점등').progress;
        if (r.progress > 0 && !r.ambushed) {
          // 유도등에 손대면 착륙장 수비대가 온다. 두 번째에는 돌입병이 섞인다
          r.ambushed = true;
          this.queue(doneNow === 0 ? 2 : 1, 0.4);
          if (doneNow === 1) this.queueOne(1.2, RUSH);
          if (doneNow === 0) this.say(HQ, '착륙장 수비대가 움직인다. 등 하나에 오래 붙어 있지 마.', true);
        }
        if (r.progress >= 1) {
          r.done = true;
          r.light.emissive.setHex(CYAN);
          this.hooks.onScore(MISSION_SCORE.relay, `유도등 점등 ${doneNow + 1} / ${lights.length}`);
          if (doneNow + 1 < lights.length) this.say(SHIP, '하나 확인. 나머지 하나도 부탁해.');
          ctx.sfx.waveClear();
        }
        markPos = r.pos;
        markLabel = '유도등';
      }
      hud.setObjective(`목표: 착륙 유도등 켜기 ${lights.filter((x) => x.done).length} / ${lights.length}`, `남쪽 착륙장${foes}`);
      hud.setRest('');
      if (lights.every((x) => x.done)) {
        this.stage = 'extract';
        this.timerEnd = now + EXTRACT_SECONDS;
        this.zone.visible = true;
        this.ship.visible = true;
        this.shipAt = now;
        this.updateShip();
        this.queue(2, 3);
        this.cut();
        this.say(SHIP, `유도등 확인, 내려간다! ${EXTRACT_SECONDS}초 이상은 못 버텨. 뛰어!`);
        ctx.sfx.waveStart();
      }
    } else if (this.stage === 'extract') {
      markPos = EXTRACT_POS;
      markLabel = '탈출 지점';
      hud.setObjective('목표: 제비에 타라', `남쪽 착륙장${foes}`);
      hud.setRest(`탈출선 출발까지 ${Math.ceil(this.timeLeft)}초`);
      const d = this.tmp.copy(p.position).sub(EXTRACT_POS);
      if (p.alive && Math.hypot(d.x, d.z) <= EXTRACT_RADIUS) {
        this.stage = 'done';
        this.zone.visible = false;
        hud.setRest('');
        hud.setComm(null);
        this.hooks.onScore(MISSION_SCORE.extract, '탈출 성공');
        hud.setObjectiveMarker(null, ctx.camera);
        this.hooks.onVictory();
        return;
      }
      if (now >= this.timerEnd) {
        this.stage = 'failed';
        this.zone.visible = false;
        hud.setRest('');
        hud.setComm(null);
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

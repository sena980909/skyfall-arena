import {
  Box3, BoxGeometry, CapsuleGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera,
  SphereGeometry, Vector3, MathUtils, LoopOnce, AnimationMixer,
} from 'three';
import type { AnimationAction, AnimationClip } from 'three';
import { CharacterController } from './CharacterController';
import { Weapon } from '@/combat/Weapon';
import { GRAVITY, RAVEN } from '@/data/heroes';
import { SPAWN_INVULN_SECONDS } from '@/data/rules';
import { computeDamage, hitscan, losBlocked, tagHitMesh, type DamageInfo, type Hittable } from '@/combat/Hitscan';
import { PulseRocket, type RocketHit } from '@/combat/PulseRocket';
import { HealField } from '@/combat/HealField';
import { FpDirect, type FpDirectParts } from '@/render/FpDirect';
import { buildAlignedGun } from '@/render/GunAlign';
import { addArmSleeves } from '@/render/ArmSleeves';
import { angleBetweenDeg, clamp, DEG2RAD, jitterDirection } from '@/core/MathUtil';
import type { PlayerInput } from '@/core/PlayerInput';
import type { GameContext } from '@/core/Context';
import type { Healable } from '@/world/HealthPack';
import type { Bot } from './Bot';
import { Raycaster } from 'three';
import { PlayerBody } from './PlayerBody';

export interface PlayerStats {
  shots: number;
  hits: number;
  headshots: number;
  kills: number;
  deaths: number;
  streak: number;
  maxStreak: number;
  rockets: number;
  fields: number;
  ults: number;
  damageTaken: number;
}

/** 1인칭 팔+총 일체형 모델 배치 (뷰모델 로컬). 스크린샷으로 튜닝 */
const FP_ARMS_LENGTH = 1.25;
/** 홀더(모델 중심) 위치: 팔 절단면이 카메라 아래쪽 바깥, 총구가 약 1.1m 앞 */
const FP_ARMS_OFFSET = new Vector3(0.0, 0.0, -0.98);
/** x: 총열 피치, y: 요, z: 롤 — 모델 Y업을 믿으므로 롤은 0 */
const FP_ARMS_ROT = new Vector3(0.12, 0.06, 0.0);
/** 일체형 뷰모델일 때 뷰모델 그룹 기준 위치 (양팔이라 중앙에 가깝고 낮게) */
const FP_ARMS_VM_BASE = new Vector3(0.22, -0.28, -0.1);

const emptyStats = (): PlayerStats => ({ shots: 0, hits: 0, headshots: 0, kills: 0, deaths: 0, streak: 0, maxStreak: 0, rockets: 0, fields: 0, ults: 0, damageTaken: 0 });

interface LockTarget {
  bot: Bot;
  point: Vector3;
  angle: number;
}

/** 1인칭 플레이어 (레이븐) — 펄스 라이플 / Shift 달리기 / 우클릭 펄스 로켓 / E 치유 필드 / Q 전술 조준 */
/** 상세 1인칭 모델 배치: 가슴 높이로 든 자세를 조준 높이까지 올리고(오른쪽·위·앞), 총구를 화면 중앙 쪽으로 살짝 돌린다 */
const FP_DETAIL_BASE = new Vector3(0.0, 0.125, -0.19);
/** 앉기: 충돌 높이(서 있을 때 / 앉았을 때), 눈이 내려가는 높이, 이동 속도 배율(앉아 걷기 클립 2.75m/s와 맞춘다) */
const STAND_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.25;
const CROUCH_EYE_DROP = 0.55;
const CROUCH_SPEED_MULT = 0.5;
// Keep the barrel parallel to the view axis. Shots travel from the muzzle to the crosshair, so a barrel that is
// turned inward (it was 0.1 rad) makes every bolt leave the gun at a visible angle.
const FP_DETAIL_YAW = 0;
/** 3인칭 카메라: 눈에서 오른쪽·위로 옮긴 축, 뒤로 물러나는 거리(m) */
const TP_SIDE = 0.5;
const TP_UP = 0.15;
const TP_BACK = 2.8;

/**
 * 재장전 효과음 시점(재장전 진행률 0..1). Blender reload 클립(1.4초) 기준:
 * 탄창이 빠지기 시작(0.16초) 직전의 멈치 클릭, 새 탄창이 끝까지 들어가는 순간(0.93초), 왼손이 총열 덮개로 돌아오는 구간(1.15초).
 * tools/blender/build_fp_rig.py의 pose('reload')와 맞춘 값이라 클립 타이밍을 바꾸면 같이 바꿔야 한다.
 */
const RELOAD_CUES = [0.14 / 1.4, 0.93 / 1.4, 1.15 / 1.4];

export class Player implements Hittable, Healable {
  readonly hero = RAVEN;
  readonly displayName = 'YOU';
  readonly ctrl: CharacterController;
  readonly weapon = new Weapon(RAVEN.weapon);
  readonly camera: PerspectiveCamera;
  readonly hitMeshes: Mesh[] = [];
  /** 히트박스 컨테이너 (씬에 추가) */
  readonly hitGroup = new Group();
  readonly viewmodel = new Group();
  private readonly muzzle = new Object3D();
  private readonly coreMat: MeshStandardMaterial;
  private rifleHolder: Group | null = null;
  /** 뷰모델 그룹 기준 위치 (모션 오프셋이 더해진다) */
  private readonly vmBase = new Vector3(0.32, -0.28, -0.55);
  hp = RAVEN.hp;
  alive = true;
  invulnUntil = 0;
  yaw = 0;
  pitch = 0;
  /** 다음에 낼 재장전 효과음 단계 (RELOAD_CUES 인덱스) */
  private reloadCue = RELOAD_CUES.length;
  sensitivity = 0.0022;
  ultCharge = 0;
  stats: PlayerStats = emptyStats();
  ctx!: GameContext;

  // 스킬 상태
  rocketReadyAt = 0;
  fieldReadyAt = 0;
  private ultUntil = 0;
  private ultReadyAnnounced = false;
  private lockShown = false;
  private baseFov = 80;

  // 뷰모델 모션
  private recoil = 0;
  private bob = 0;
  private bobAmp = 0;
  private swayX = 0;
  private swayY = 0;
  private strafeTilt = 0;
  private sprintBlend = 0;
  private landKick = 0;
  private wasOnGround = true;
  private prevVelY = 0;
  private rocketKick = 0;
  sprinting = false;
  /** 임무의 운반물을 들고 있는가(Mission이 켜고 끈다). 들고 있는 동안은 달릴 수 없다 */
  carrying = false;
  /** 뷰모델 전용 렌더 레이어 (벽 뚫림 방지용 2패스) */
  static readonly VIEWMODEL_LAYER = 1;
  /** 뷰모델 전용 FOV(월드 FOV와 분리해 팔·총이 과장되지 않게) */
  static readonly VIEWMODEL_FOV = 56;
  private readonly eyeHeight = 1.6;
  /** 앉아 있는가(C를 누르는 동안). crouchT는 0..1로 부드럽게 따라가는 값: 눈높이와 판정 높이에 쓴다 */
  crouching = false;
  private crouchT = 0;

  /** 지금 눈높이(발에서) */
  private get eyeNow(): number {
    return this.eyeHeight - CROUCH_EYE_DROP * this.crouchT;
  }

  /** 머리 판정의 중심 높이, 가슴 높이(발에서). 적이 조준하고 시야를 잴 때 쓴다 */
  get headHeight(): number {
    return 1.62 - CROUCH_EYE_DROP * this.crouchT;
  }

  get chestHeight(): number {
    return 1.0 - 0.35 * this.crouchT;
  }
  private fpRigActive = false;
  /** 상세 1인칭 모델(팔·총 한 덩어리) 사용 중 */
  private fpDetailActive = false;
  /** 힉스필드 모델을 그대로 붙인 1인칭 총(있으면 재장전 움직임도 이쪽이 맡는다) */
  private fpDirect: FpDirect | null = null;
  private fpCant = 0;
  private fpDown = 0;
  private fpSeat = 0;
  /** 3인칭 시점 (V로 전환). 몸 모델이 있어야 켤 수 있다 */
  thirdPerson = false;
  body: PlayerBody | null = null;
  /** 3인칭 카메라에서 몸 깊이까지의 거리(조준 광선을 몸 앞에서 시작하는 데 쓴다) */
  private tpDist = 0;
  private tpLastT = 0;
  private readonly tpRay = new Raycaster();
  private readonly tpPivot = new Vector3();
  private readonly tpDir = new Vector3();
  private readonly tpFrom = new Vector3();
  private fpMixer: AnimationMixer | null = null;
  private fpIdle: AnimationAction | null = null;
  private fpReload: AnimationAction | null = null;
  private fpReloadBlend = 0;
  /** 사망 카메라: 쓰러지는 시간(초, -1이면 비활성), 기울 방향, 처치자 쪽 요 */
  private deathT = -1;
  private deathRoll = 0;
  private deathYaw0 = 0;
  private deathYawDelta = 0;
  private deathPitch0 = 0;
  private readonly bodyHit: Mesh;
  private readonly headHit: Mesh;
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly wish = new Vector3();
  private readonly shotDir = new Vector3();
  private readonly tmp = new Vector3();
  private readonly camDir = new Vector3();
  private lastMoved = 0;

  get position(): Vector3 {
    return this.ctrl.pos;
  }

  get maxHp(): number {
    return this.hero.hp;
  }

  get ultActive(): boolean {
    return this.ctx.now < this.ultUntil;
  }

  constructor(colliders: Box3[], camera: PerspectiveCamera) {
    this.ctrl = new CharacterController(colliders);
    this.camera = camera;
    this.camera.rotation.order = 'YXZ';
    this.baseFov = camera.fov;

    const invis = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.bodyHit = tagHitMesh(new Mesh(new CapsuleGeometry(0.35, 0.8, 4, 8), invis), this, 'body');
    this.headHit = tagHitMesh(new Mesh(new SphereGeometry(0.22, 8, 8), invis), this, 'head');
    this.hitMeshes.push(this.bodyHit, this.headHit);
    this.hitGroup.add(this.bodyHit, this.headHit);

    this.coreMat = new MeshStandardMaterial({ color: 0x2f80ff, emissive: 0x1a4fb0, emissiveIntensity: 0.6, roughness: 0.4 });
    this.buildViewmodel();
    camera.add(this.viewmodel);
    this.viewmodel.traverse((o) => o.layers.set(Player.VIEWMODEL_LAYER));
  }

  private buildViewmodel(): void {
    const dark = new MeshStandardMaterial({ color: 0x1d2633, roughness: 0.6, metalness: 0.4 });
    const body = new Mesh(new BoxGeometry(0.11, 0.16, 0.5), dark);
    const barrel = new Mesh(new BoxGeometry(0.05, 0.05, 0.35), dark);
    barrel.position.set(0, 0.05, -0.4);
    const core = new Mesh(new BoxGeometry(0.12, 0.05, 0.2), this.coreMat);
    core.position.set(0, 0.02, -0.1);
    const grip = new Mesh(new BoxGeometry(0.06, 0.18, 0.08), dark);
    grip.position.set(0, -0.15, 0.1);
    grip.rotation.x = 0.3;
    this.muzzle.position.set(0, 0.05, -0.58);
    this.viewmodel.add(body, barrel, core, grip, this.muzzle);
    this.viewmodel.position.set(0.32, -0.28, -0.55);
  }

  /** 생성된 라이플 GLB로 뷰모델 교체 (정점 주축으로 총열을 -Z에 정렬) */
  applyRifleModel(model: Group): void {
    const { group: holder, muzzle, yawErrorDeg } = buildAlignedGun(model, 0.62);
    console.info(`[Gun] 뷰모델 정렬: 원본 총열 축이 Z에서 ${yawErrorDeg.toFixed(1)}° 틀어져 있어 보정`);
    for (const c of [...this.viewmodel.children]) if (c !== this.muzzle) c.visible = false;
    holder.position.set(0.02, -0.04, -0.02);
    holder.rotation.y = 0.035;
    this.viewmodel.add(holder);
    this.viewmodel.remove(this.muzzle);
    holder.add(this.muzzle);
    this.muzzle.position.copy(muzzle);
    this.rifleHolder = holder;
    this.viewmodel.traverse((o) => {
      o.layers.set(Player.VIEWMODEL_LAYER);
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
  }

  /**
   * 힉스필드 생성 1인칭 팔+라이플 일체형 모델로 뷰모델 교체.
   * 주축 정렬(총열 -Z, 위 +Y) 후 총구는 맨 앞 지점. 라이플 단독 뷰모델은 숨긴다.
   */
  /**
   * Blender 제작 1인칭 리그 적용. 리그는 카메라 공간 기준으로 만들어져 있어(원점=눈, -Z 정면) 뷰모델 원점에 그대로 붙인다.
   * 재장전은 클립 시간을 무기의 재장전 진행도에 직접 맞춘다(게임 로직과 모션이 항상 일치).
   */
  applyFpRig(scene: Group, clips: AnimationClip[]): void {
    if (this.rifleHolder) this.rifleHolder.visible = false;
    for (const c of [...this.viewmodel.children]) if (c !== this.muzzle) c.visible = false;
    this.vmBase.set(0, 0, 0);
    this.viewmodel.position.set(0, 0, 0);
    this.viewmodel.rotation.set(0, 0, 0);
    this.viewmodel.add(scene);
    const muzzleBone = scene.getObjectByName('muzzle');
    if (muzzleBone) {
      this.muzzle.parent?.remove(this.muzzle);
      muzzleBone.add(this.muzzle);
      this.muzzle.position.set(0, 0, 0);
    }
    this.fpMixer = new AnimationMixer(scene);
    const find = (n: string): AnimationClip | undefined => clips.find((c) => c.name === n);
    const idle = find('idle');
    const reload = find('reload');
    if (idle) {
      this.fpIdle = this.fpMixer.clipAction(idle);
      this.fpIdle.play();
    }
    if (reload) {
      this.fpReload = this.fpMixer.clipAction(reload);
      this.fpReload.setLoop(LoopOnce, 1);
      this.fpReload.clampWhenFinished = true;
      this.fpReload.play();
      this.fpReload.setEffectiveWeight(0);
    }
    this.fpRigActive = true;
    this.viewmodel.traverse((o) => {
      o.layers.set(Player.VIEWMODEL_LAYER);
      o.frustumCulled = false; // 스킨 메시의 바운딩이 레스트 포즈 기준이라 화면에 있어도 컬링될 수 있다
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
        // 밝은 하늘 환경맵 반사로 색이 하얗게 뜨지 않게, 발광은 과하지 않게
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          const sm = mat as MeshStandardMaterial;
          sm.envMapIntensity = 0.35;
          if (sm.emissiveIntensity > 1) sm.emissiveIntensity = 1.4;
        }
      }
    });
    console.info(`[Gun] 1인칭 리그 적용: 클립 ${clips.map((c) => c.name).join(', ')}`);
  }

  /** 리그 클립 갱신: 대기는 흐르고, 재장전은 진행도에 맞춰 스크럽 */
  private updateFpRig(dt: number, now: number): void {
    if (!this.fpMixer) return;
    const reloading = this.weapon.reloading;
    this.fpReloadBlend += ((reloading ? 1 : 0) - this.fpReloadBlend) * Math.min(1, dt * 14);
    if (this.fpReload) {
      if (reloading) this.fpReload.time = this.weapon.reloadProgress(now) * this.fpReload.getClip().duration;
      this.fpReload.setEffectiveWeight(this.fpReloadBlend);
    }
    if (this.fpIdle) this.fpIdle.setEffectiveWeight(1 - this.fpReloadBlend);
    this.fpMixer.update(dt);
  }

  /**
   * 힉스필드에서 받은 1인칭 모델(두 팔이 총을 쥔 한 덩어리)을 그대로 붙인다(Blender를 거치지 않는다). 자리와 재장전 움직임은 FpDirect가 정한다.
   * 뷰모델 전체의 흔들림·반동·달리기 자세는 animateViewmodel이 그대로 맡는다.
   */
  applyFpDirect(parts: FpDirectParts): void {
    if (this.rifleHolder) this.rifleHolder.visible = false;
    for (const c of [...this.viewmodel.children]) if (c !== this.muzzle) c.visible = false;
    this.vmBase.set(0, 0, 0);
    this.viewmodel.position.set(0, 0, 0);
    this.viewmodel.rotation.set(0, 0, 0);
    this.fpDirect = new FpDirect(parts, Player.VIEWMODEL_LAYER);
    this.viewmodel.add(this.fpDirect.root);
    this.muzzle.parent?.remove(this.muzzle);
    this.fpDirect.muzzle.add(this.muzzle);
    this.muzzle.position.set(0, 0, 0);
    this.fpDetailActive = true;
    this.fpRigActive = false;
    this.fpMixer = null;
    this.fpReload = null;
    this.fpIdle = null;
    if (import.meta.env.DEV) (window as unknown as { __fp: FpDirect }).__fp = this.fpDirect;
    console.info('[Gun] 힉스필드 모델 직접 적용');
  }

  /**
   * 상세 1인칭 모델 적용. 주인공 몸(파란 상세 모델)이 총을 든 자세에서 팔·총만 남긴 것으로, 눈이 원점이다.
   * 몸은 총을 가슴 높이로 들고 있으므로 조준 높이까지 들어 올려 화면에 놓는다. 팔·총이 한 덩어리라 본 애니메이션은 없고,
   * 재장전은 뷰모델을 기울여 화면 아래로 내렸다 올리는 것으로 표현한다(animateViewmodel).
   */
  applyFpDetail(model: Group, clips: AnimationClip[] = []): void {
    if (this.rifleHolder) this.rifleHolder.visible = false;
    for (const c of [...this.viewmodel.children]) if (c !== this.muzzle) c.visible = false;
    this.vmBase.copy(FP_DETAIL_BASE);
    this.viewmodel.position.copy(this.vmBase);
    this.viewmodel.rotation.set(0, 0, 0);
    const holder = new Group();
    holder.rotation.y = FP_DETAIL_YAW;
    holder.add(model);
    this.viewmodel.add(holder);
    const mz = model.getObjectByName('muzzle');
    if (mz) {
      this.muzzle.parent?.remove(this.muzzle);
      mz.add(this.muzzle);
      this.muzzle.position.set(0, 0, 0);
    }
    this.fpDetailActive = true;
    this.fpRigActive = false;
    // 재장전 클립이 있으면(왼팔·탄창이 따로 움직이는 리그) 무기의 재장전 진행도에 맞춰 재생한다. 없으면 뷰모델을 기울이는 연출로 대신한다
    const reload = clips.find((c) => c.name === 'reload');
    if (reload) {
      this.fpMixer = new AnimationMixer(model);
      this.fpReload = this.fpMixer.clipAction(reload);
      this.fpReload.setLoop(LoopOnce, 1);
      this.fpReload.clampWhenFinished = true;
      this.fpReload.play();
      this.fpReload.setEffectiveWeight(0);
    }
    this.viewmodel.traverse((o) => {
      o.layers.set(Player.VIEWMODEL_LAYER);
      o.frustumCulled = false;
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          const sm = mat as MeshStandardMaterial;
          sm.envMapIntensity = 0.3;
          // Cap faces keep their own plain material. The magazine is a generated mesh like the gun and gets the same surface.
          if (sm.name !== 'bot_detail' && sm.name !== 'mag_detail' && sm.name !== 'gun_detail') continue;
          // The generated roughness/metal maps are near-mirror (roughness ~0.17), which reads as wet chrome up close.
          // Use a painted hard-surface look instead and keep only the normal map.
          sm.metalnessMap = null;
          sm.roughnessMap = null;
          sm.metalness = 0.3;
          sm.roughness = 0.55;
          sm.envMapIntensity = 0.3;
          sm.normalScale.set(0.8, 0.8);
          if (sm.map) sm.map.anisotropy = 8;
          sm.needsUpdate = true;
        }
      }
    });
    console.info('[Gun] 상세 1인칭 모델 적용');
  }

  /** 3인칭 몸 모델 생성. 돌려준 그룹을 씬에 넣어야 한다 */
  applyBody(source: Group, clips: Record<string, AnimationClip>, rifle: Object3D | null): Group {
    this.body = new PlayerBody(source, clips, rifle);
    return this.body.group;
  }

  setThirdPerson(on: boolean): void {
    if (on && !this.body) return;
    this.thirdPerson = on;
    this.applyViewMode();
    this.syncCamera();
  }

  /** 시점에 맞춰 1인칭 팔·총과 3인칭 몸 중 하나만 보이게 한다 */
  private applyViewMode(): void {
    this.viewmodel.visible = !this.thirdPerson && this.alive;
    if (this.body) this.body.group.visible = this.thirdPerson;
  }

  /** 조준 광선의 출발점. 3인칭에서는 카메라와 몸 사이의 물체를 맞히지 않도록 몸 깊이에서 시작한다 */
  private aimFrom(dir: Vector3): Vector3 {
    if (!this.thirdPerson) return this.camera.position;
    return this.tpFrom.copy(this.camera.position).addScaledVector(dir, this.tpDist);
  }

  applyFpArmsModel(model: Group): void {
    // 모델의 Y업을 그대로 두고 총열 요만 -Z로 맞춘다(팔 때문에 롤이 생기지 않음)
    const { group: holder, muzzle, yawErrorDeg } = buildAlignedGun(model, FP_ARMS_LENGTH, true);
    console.info(`[Gun] 1인칭 팔 모델 정렬: 요 ${yawErrorDeg.toFixed(1)}° 보정 (Y업 유지)`);
    if (this.rifleHolder) this.rifleHolder.visible = false;
    for (const c of [...this.viewmodel.children]) if (c !== this.muzzle) c.visible = false;
    holder.position.copy(FP_ARMS_OFFSET);
    holder.rotation.set(FP_ARMS_ROT.x, FP_ARMS_ROT.y, FP_ARMS_ROT.z);
    this.vmBase.copy(FP_ARMS_VM_BASE);
    this.viewmodel.add(holder);
    // 전완 절단면 → 어깨(카메라 아래·뒤 양쪽) 방향으로 상완을 이어 붙여 팔이 화면 밖으로 자연스럽게 빠져나가게
    this.viewmodel.position.copy(this.vmBase);
    this.viewmodel.rotation.set(0, 0, 0);
    this.camera.updateMatrixWorld(true);
    const shoulder = (x: number) => holder.worldToLocal(this.camera.localToWorld(new Vector3(x, -0.42, 0.3)));
    const sleeves = addArmSleeves(holder, { shoulders: [shoulder(-0.26), shoulder(0.26)] });
    console.info(`[Gun] 1인칭 팔 절단부 ${sleeves.length / 2}곳에 관절·상완 연결`);
    this.muzzle.parent?.remove(this.muzzle);
    holder.add(this.muzzle);
    this.muzzle.position.copy(muzzle);
    this.viewmodel.traverse((o) => {
      o.layers.set(Player.VIEWMODEL_LAYER);
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
  }

  spawn(pos: Vector3, now: number): void {
    this.ctrl.teleport(pos);
    this.hp = this.hero.hp;
    this.alive = true;
    this.invulnUntil = now + SPAWN_INVULN_SECONDS;
    this.weapon.reset();
    this.yaw = 0;
    this.pitch = 0;
    this.recoil = 0;
    this.ultUntil = 0;
    this.rocketKickUntil = 0;
    this.crouching = false;
    this.crouchT = 0;
    this.ctrl.height = STAND_HEIGHT;
    this.rocketReadyAt = Math.min(this.rocketReadyAt, now);
    this.fieldReadyAt = Math.min(this.fieldReadyAt, now);
    this.body?.reset(this.yaw);
    this.applyViewMode();
    this.deathT = -1;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.syncCamera();
    this.syncHitboxes();
  }

  resetStats(): void {
    this.stats = emptyStats();
    this.ultCharge = 0;
    this.ultReadyAnnounced = false;
    this.rocketReadyAt = 0;
    this.fieldReadyAt = 0;
  }

  /** 사망 카메라 시작: 처치자 방향으로 천천히 고개가 돌아가며, 맞은 쪽 반대로 기울어 바닥에 쓰러진다 */
  private beginDeathCam(from: Vector3): void {
    const p = this.ctrl.pos;
    const dx = from.x - p.x;
    const dz = from.z - p.z;
    this.deathYaw0 = this.yaw;
    this.deathPitch0 = this.pitch;
    const target = Math.abs(dx) + Math.abs(dz) > 1e-3 ? Math.atan2(-dx, -dz) : this.yaw;
    let delta = target - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.deathYawDelta = delta;
    // 오른쪽에서 맞으면 왼쪽으로 쓰러진다
    const rightDot = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    this.deathRoll = (rightDot > 0 ? 1 : -1) * 0.6;
    this.deathT = 0;
  }

  /** Game이 사망 상태 동안 매 스텝 호출. 가속하며 쓰러지고 바닥에서 살짝 튕긴 뒤 누운 채 처치자를 본다 */
  updateDeathCam(dt: number): void {
    if (this.deathT < 0) return;
    this.deathT += dt;
    if (this.thirdPerson && this.body) {
      // 3인칭: 몸이 쓰러지는 모습을 카메라가 조금 위에서 내려다본다
      this.body.updateDeath(dt);
      this.pitch += (-0.35 - this.pitch) * Math.min(1, dt * 3);
      this.syncCamera();
      return;
    }
    const FALL = 0.75;
    const k = Math.min(1, this.deathT / FALL);
    const ease = k * k;
    const sm = k * k * (3 - 2 * k);
    let bounce = 0;
    if (k >= 1) {
      const b = (this.deathT - FALL) / 0.28;
      if (b < 1) bounce = Math.sin(b * Math.PI) * 0.06;
    }
    const eye = this.eyeNow + (0.32 - this.eyeNow) * ease + bounce;
    const yawK = Math.min(1, this.deathT / 1.4);
    const yaw = this.deathYaw0 + this.deathYawDelta * (yawK * yawK * (3 - 2 * yawK));
    const pitch = this.deathPitch0 + (0.3 - this.deathPitch0) * sm;
    const roll = this.deathRoll * sm + bounce * 1.5 * Math.sign(this.deathRoll);
    const p = this.ctrl.pos;
    this.camera.position.set(p.x, p.y + eye, p.z);
    this.camera.rotation.set(pitch, yaw, roll);
  }

  private syncCamera(): void {
    const p = this.ctrl.pos;
    // 카메라 상하 흔들림은 아주 작게 (멀미 방지), 총이 대부분의 움직임을 표현한다
    const camBob = Math.sin(this.bob * 2) * 0.012 * this.bobAmp;
    const ey = p.y + this.eyeNow + this.ctrl.visualYOffset;
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    if (!this.thirdPerson) {
      this.camera.position.set(p.x, ey + camBob - this.landKick * 0.4, p.z);
      return;
    }
    // 3인칭: 오른쪽 어깨 너머. 눈에서 오른쪽·위로 옮긴 점을 축으로 시선 반대쪽으로 물러나고, 벽에 막히면 그 앞까지만 간다
    const cp = Math.cos(this.pitch);
    this.tpDir.set(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.tpPivot.set(p.x + Math.cos(this.yaw) * TP_SIDE, ey + TP_UP, p.z - Math.sin(this.yaw) * TP_SIDE);
    let dist = TP_BACK;
    const meshes = this.ctx?.map.meshes;
    if (meshes) {
      this.tpRay.set(this.tpPivot, this.tpDir);
      this.tpRay.far = TP_BACK + 0.3;
      const hit = this.tpRay.intersectObjects(meshes, false)[0];
      if (hit) dist = Math.max(0.5, hit.distance - 0.3);
    }
    // 가려지면 바로 당기고(벽 안으로 들어가면 안 된다), 트이면 천천히 물러난다 → 기둥·상자 옆을 지날 때 거리가 앞뒤로 튀지 않는다
    const tnow = this.ctx?.now ?? 0;
    const tdt = Math.min(0.1, Math.max(0, tnow - this.tpLastT));
    if (tnow < this.tpLastT || tnow - this.tpLastT > 0.5 || this.tpDist <= 0) this.tpDist = dist; // 첫 프레임·부활 직후
    else if (dist > this.tpDist) dist = this.tpDist + (dist - this.tpDist) * Math.min(1, tdt * 3.5);
    this.tpLastT = tnow;
    this.tpDist = dist;
    this.camera.position.copy(this.tpPivot).addScaledVector(this.tpDir, dist);
  }

  private syncHitboxes(): void {
    const p = this.ctrl.pos;
    // 앉으면 몸통 판정이 1.5m → 1.05m로 줄고 머리 판정이 0.55m 내려간다
    const squash = 1 - 0.3 * this.crouchT;
    this.bodyHit.scale.y = squash;
    this.bodyHit.position.set(p.x, p.y + 0.75 * squash, p.z);
    this.headHit.position.set(p.x, p.y + this.headHeight, p.z);
    this.hitGroup.updateMatrixWorld(true);
  }

  update(dt: number, input: PlayerInput): void {
    const ctx = this.ctx;
    const now = ctx.now;
    if (!this.alive) return;
    const ab = this.hero.abilities;

    // 시점
    const m = input.consumeMouse();
    const maxTurn = 1.05;
    this.yaw -= clamp(m.dx * this.sensitivity, -maxTurn, maxTurn);
    this.pitch = clamp(this.pitch - clamp(m.dy * this.sensitivity, -maxTurn, maxTurn), -89 * DEG2RAD, 89 * DEG2RAD);
    const k = Math.min(1, dt * 12);
    this.swayX += (clamp(-m.dx * 0.0009, -0.06, 0.06) - this.swayX) * k;
    this.swayY += (clamp(-m.dy * 0.0009, -0.05, 0.05) - this.swayY) * k;
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // 궁 게이지
    const ultActive = this.ultActive;
    if (!ultActive) {
      this.ultCharge = Math.min(ab.ult.chargeNeeded, this.ultCharge + ab.ult.chargePerSecond * dt);
      if (this.ultCharge >= ab.ult.chargeNeeded && !this.ultReadyAnnounced) {
        this.ultReadyAnnounced = true;
        ctx.sfx.ultReady();
        ctx.hud.killFeed('전술 조준 준비 완료 (Q)', 'hs');
      }
    }

    // 스킬 입력
    if (input.mouseDown[2]) this.tryRocket();
    if (input.justPressed('KeyE')) this.tryHealField();
    if (input.justPressed('KeyQ')) this.tryUlt();
    if (input.justPressed('KeyV') && this.body) {
      this.setThirdPerson(!this.thirdPerson);
      ctx.hud.killFeed(this.thirdPerson ? '3인칭 시점' : '1인칭 시점');
    }

    // 이동 — Shift 유지 = 달리기 (앞으로 이동 중, 사격 중이 아닐 때만)
    const f = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const r = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    const firing = input.mouseDown[0] || now < this.rocketKickUntil;
    // 앉기 — Ctrl 또는 C를 누르고 있는 동안. 일어서려면 머리 위가 비어 있어야 한다.
    // (브라우저에서 Ctrl+W는 탭 닫기다: Game이 닫히기 전에 확인 창을 띄우고, 전체 화면에서는 키보드 잠금으로 게임이 받는다)
    const wantCrouch = input.isDown('ControlLeft') || input.isDown('ControlRight') || input.isDown('KeyC');
    if (wantCrouch !== this.crouching && (wantCrouch || this.ctrl.fits(STAND_HEIGHT))) {
      this.crouching = wantCrouch;
      this.ctrl.height = wantCrouch ? CROUCH_HEIGHT : STAND_HEIGHT;
    }
    this.crouchT += ((this.crouching ? 1 : 0) - this.crouchT) * Math.min(1, dt * 12);
    this.sprinting = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && f > 0 && this.ctrl.onGround && !firing && !this.carrying && !this.crouching;
    const speed = this.hero.moveSpeed * (this.sprinting ? ab.sprint.speedMult : this.crouching && this.ctrl.onGround ? CROUCH_SPEED_MULT : 1);
    this.wish.set(0, 0, 0).addScaledVector(this.forward, f).addScaledVector(this.right, r);
    if (this.wish.lengthSq() > 0) this.wish.normalize().multiplyScalar(speed);
    let jumpVel = 0;
    if (input.justPressed('Space') && this.ctrl.onGround) {
      jumpVel = Math.sqrt(2 * GRAVITY * this.hero.jumpHeight);
      ctx.sfx.jump();
    }
    this.prevVelY = this.ctrl.vel.y;
    this.lastMoved = this.ctrl.moveAndSlide(dt, this.wish, jumpVel);
    const moveSpeed = this.lastMoved / Math.max(dt, 1e-4);

    // 착지 감지 → 총·카메라가 살짝 눌린다
    if (this.ctrl.onGround && !this.wasOnGround) {
      this.landKick = Math.min(0.09, Math.abs(this.prevVelY) * 0.006);
      if (Math.abs(this.prevVelY) > 4) ctx.sfx.land(clamp((Math.abs(this.prevVelY) - 4) / 8, 0, 1));
    }
    this.wasOnGround = this.ctrl.onGround;
    this.landKick = Math.max(0, this.landKick - dt * 0.35);

    // 걸음 사이클: 이동 속도에 비례한 위상·진폭
    const targetAmp = this.ctrl.onGround ? clamp(moveSpeed / this.hero.moveSpeed, 0, 1.6) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
    if (this.ctrl.onGround && moveSpeed > 0.3) {
      const prev = this.bob;
      this.bob += dt * (this.sprinting ? 13.5 : this.crouching ? 7.5 : 10.5);
      if (Math.floor(prev / Math.PI) !== Math.floor(this.bob / Math.PI)) ctx.sfx.footstep(undefined, this.sprinting ? 0.32 : this.crouching ? 0.1 : 0.25);
    }

    // 무기
    this.weapon.update(now, dt);
    if (input.justPressed('KeyR') && this.weapon.startReload(now)) this.reloadCue = 0;
    if (this.weapon.ammo === 0 && !this.weapon.reloading && this.weapon.startReload(now)) this.reloadCue = 0;
    // 재장전 효과음: 애니메이션의 동작 시점에 맞춰 단계별로 낸다
    if (this.weapon.reloading) {
      const p = this.weapon.reloadProgress(now);
      while (this.reloadCue < RELOAD_CUES.length && p >= RELOAD_CUES[this.reloadCue]) ctx.sfx.reloadStage(this.reloadCue++);
    } else this.reloadCue = RELOAD_CUES.length;
    if (input.mouseDown[0] && !this.sprinting) {
      if (this.weapon.canFire(now)) this.fire();
      else if (input.mousePressed[0] && this.weapon.ammo === 0) ctx.sfx.empty();
    }
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.rocketKick = Math.max(0, this.rocketKick - dt * 3);

    this.animateViewmodel(dt, now, r);
    this.coreMat.emissiveIntensity = ultActive ? 2.0 + Math.sin(now * 14) * 0.6 : 0.6;

    // FOV (달리기 확장)
    const targetFov = this.baseFov + (this.sprinting ? ab.sprint.fovAdd : 0);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 10);
      this.camera.updateProjectionMatrix();
    }

    if (this.thirdPerson && this.body) {
      this.body.update(dt, {
        pos: this.ctrl.pos, yaw: this.yaw, pitch: this.pitch, onGround: this.ctrl.onGround,
        reload: this.weapon.reloading ? this.weapon.reloadProgress(now) : null, kick: this.recoil, sprint: this.sprinting,
        crouch: this.crouching,
      });
    }
    this.syncCamera();
    this.syncHitboxes();
    this.fxMuzzlePosition(this.tmp);
    ctx.fx.setMuzzlePosition(this.tmp);

    // 전술 조준: 화면 안의 조준 가능한 적 표시
    if (ultActive) {
      const targets = this.lockTargets();
      ctx.hud.setLockMarkers(targets.map((t) => t.point), this.camera);
      this.lockShown = true;
    } else if (this.lockShown) {
      ctx.hud.setLockMarkers([], this.camera);
      this.lockShown = false;
    }

    // HUD
    const hud = ctx.hud;
    hud.setHp(this.hp, this.hero.hp);
    const w = this.weapon;
    hud.setAmmo(w.ammo, w.def.magSize, w.reloading ? `재장전 ${Math.round(w.reloadProgress(now) * 100)}%` : '');
    hud.setCrosshair(6 + this.totalSpread() * 7);
    hud.setUlt((this.ultCharge / ab.ult.chargeNeeded) * 100, ultActive, Math.max(0, this.ultUntil - now));
    hud.setSkill(0, Math.max(0, this.rocketReadyAt - now), ab.rocket.cooldown);
    hud.setSkill(1, Math.max(0, this.fieldReadyAt - now), ab.field.cooldown);
  }

  private rocketKickUntil = 0;

  /**
   * 1인칭 총 모션
   * - 걸음: 8자 궤적(좌우 sin, 상하 |cos|) + 걸음에 맞춘 롤
   * - 달리기: 총을 내리고 안쪽으로 돌려 드는 자세로 블렌드
   * - 옆걸음: 이동 방향으로 기울임, 시선 이동: 뒤처짐(스웨이)
   * - 점프/착지: 공중에서 살짝 올라가고 착지 때 눌림, 정지 시 숨쉬기
   * - 재장전: 내렸다 올리기, 사격/로켓: 반동
   */
  /**
   * 총구 위치를 월드 FOV 기준으로 보정해 돌려준다.
   * 뷰모델은 별도 FOV로 그리므로, 실제 총구 월드 좌표를 그대로 쓰면 궤적·섬광이
   * 화면에 보이는 총구보다 바깥(아래/오른쪽)에서 출발한다. 같은 화면 위치에 오도록 x,y를 스케일한다.
   */
  private fxMuzzlePosition(out: Vector3): Vector3 {
    if (this.thirdPerson && this.body) return this.body.getMuzzle(out);
    this.muzzle.getWorldPosition(out);
    this.camera.worldToLocal(out);
    const k = Math.tan(MathUtils.degToRad(this.camera.fov) * 0.5) / Math.tan(MathUtils.degToRad(Player.VIEWMODEL_FOV) * 0.5);
    out.x *= k;
    out.y *= k;
    return this.camera.localToWorld(out);
  }

  private animateViewmodel(dt: number, now: number, strafeInput: number): void {
    const vm = this.viewmodel;
    const a = this.bobAmp;
    const sprintTarget = this.sprinting ? 1 : 0;
    this.sprintBlend += (sprintTarget - this.sprintBlend) * Math.min(1, dt * 9);
    this.strafeTilt += (-strafeInput * 0.07 - this.strafeTilt) * Math.min(1, dt * 7);
    const sb = this.sprintBlend;
    const bobScale = 1 + sb * 0.8;
    const bx = Math.sin(this.bob) * 0.016 * a * bobScale;
    const by = -Math.abs(Math.cos(this.bob)) * 0.018 * a * bobScale + 0.009 * a;
    const bRoll = Math.sin(this.bob) * 0.035 * a * bobScale;
    const breathe = Math.sin(now * 1.7) * 0.0035 * (1 - Math.min(1, a));
    const air = this.ctrl.onGround ? 0 : clamp(-this.ctrl.vel.y * 0.004, -0.035, 0.035);
    // 리그가 있으면 재장전은 클립이 담당하므로 뷰모델 통째 기울이기는 끈다
    const reloadDip = !this.fpRigActive && !this.fpDetailActive && this.weapon.reloading ? Math.sin(this.weapon.reloadProgress(now) * Math.PI) : 0;
    // 상세 1인칭 모델의 재장전: 팔·총이 한 덩어리라 탄창 교체는 화면 아래에서 일어난다.
    // 구간은 3인칭 재장전(tools/blender/reload_timeline.py)과 같다: 총을 기울이고 → 내려서 탄창을 갈고 → 밀어 넣는 충격 → 복귀
    let tCant = 0;
    let tDown = 0;
    let tSeat = 0;
    if (this.fpDetailActive && !this.fpReload && !this.fpDirect && this.weapon.reloading) {
      const rt = this.weapon.reloadProgress(now) * this.weapon.def.reloadTime;
      const sm = (a0: number, a1: number): number => {
        const k = clamp((rt - a0) / (a1 - a0), 0, 1);
        return k * k * (3 - 2 * k);
      };
      tCant = sm(0.03, 0.22) * (1 - sm(1.1, 1.34));
      tDown = sm(0.16, 0.42) * (1 - sm(0.9, 1.12));
      tSeat = sm(0.88, 0.93) * (1 - sm(0.93, 1.02));
    }
    // 목표값을 바로 쓰지 않고 따라가게 한다: 궁극기로 재장전이 도중에 끝나도 총이 한 프레임에 튀지 않는다
    const follow = Math.min(1, dt * 14);
    this.fpCant += (tCant - this.fpCant) * follow;
    this.fpDown += (tDown - this.fpDown) * follow;
    this.fpSeat += (tSeat - this.fpSeat) * Math.min(1, dt * 40);
    const dCant = this.fpCant;
    const dDown = this.fpDown;
    const dSeat = this.fpSeat;
    this.updateFpRig(dt, now);
    this.fpDirect?.update(dt, this.weapon.reloading ? this.weapon.reloadProgress(now) : -1);

    // 재장전: 총구를 살짝 내리고 몸쪽으로 당기며 안쪽으로 굴린다 (위로 들면 카메라 앞 전완 절단면이 화면에 올라온다)
    vm.position.x = this.vmBase.x + bx + this.swayX * 0.25 + sb * 0.03 + reloadDip * 0.04 - dCant * 0.03;
    vm.position.y = this.vmBase.y + by + breathe + air - this.landKick * 0.6 - reloadDip * 0.02 - sb * 0.04 - this.rocketKick * 0.03
      + dCant * 0.02 - dDown * 0.15 + dSeat * 0.014;
    const rk = this.fpRigActive || this.fpDetailActive ? 0.4 : 1; // 카메라 원점이 피벗이라 같은 반동도 크게 보인다
    vm.position.z = this.vmBase.z + this.recoil * 0.07 * rk + this.rocketKick * 0.2 * rk + sb * 0.03 + reloadDip * 0.05;
    // 로켓 반동은 위로 들기보다 뒤로 밀기 위주 (위로 들면 카메라 앞 전완 절단면이 보인다)
    vm.rotation.x = this.recoil * 0.12 * rk + this.rocketKick * 0.08 + reloadDip * 0.0 + this.swayY - sb * 0.14 * (this.fpRigActive ? 0.8 : 1) - this.landKick * 1.2
      + dCant * 0.12 - dDown * 0.22;
    vm.rotation.y = this.swayX + sb * 0.28 + reloadDip * 0.14 + dCant * 0.18;
    vm.rotation.z = bRoll + this.strafeTilt + reloadDip * 0.35 + sb * 0.18 - dCant * 0.45;
  }

  // ---------- 스킬 ----------

  /** 우클릭: 펄스 로켓 — 조준점으로 수렴하도록 총구에서 발사 */
  private tryRocket(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.rocket;
    if (ctx.now < this.rocketReadyAt) return;
    this.rocketReadyAt = ctx.now + ab.cooldown;
    this.stats.rockets++;
    this.sprinting = false;
    this.camera.getWorldDirection(this.camDir);
    const aim = hitscan(this.aimFrom(this.camDir), this.camDir, ab.range, ctx.map.meshes, ctx.hittables(), this).point;
    this.fxMuzzlePosition(this.tmp);
    const dir = aim.clone().sub(this.tmp).normalize();
    ctx.spawnProjectile(new PulseRocket(ctx, this.tmp.clone(), dir, this, (h) => this.onRocketHit(h)));
    ctx.fx.muzzleSprite(this.tmp, 0.28, dir);
    ctx.fx.muzzleFlash(6);
    ctx.sfx.rocketFire();
    ctx.onNoise(this.ctrl.pos, 30);
    this.rocketKick = 1;
    this.rocketKickUntil = ctx.now + 0.35;
  }

  private onRocketHit(h: RocketHit): void {
    const ctx = this.ctx;
    // 명중률(라이플 기준)에는 포함하지 않는다
    const ab = this.hero.abilities.ult;
    if (!this.ultActive) this.ultCharge = Math.min(ab.chargeNeeded, this.ultCharge + h.amount * ab.chargePerDamage);
    ctx.hud.damageNumber(h.point, this.camera, h.amount, false);
    ctx.hud.hitmarkerFlash(!h.target.alive ? 'kill' : 'hit');
    if (h.direct) ctx.sfx.hit();
  }

  /** E: 치유 필드 — 발밑에 설치 */
  private tryHealField(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.field;
    if (ctx.now < this.fieldReadyAt) return;
    this.fieldReadyAt = ctx.now + ab.cooldown;
    this.stats.fields++;
    ctx.spawnProjectile(new HealField(ctx, this.ctrl.pos));
  }

  /** Q: 전술 조준 — 지속 시간 동안 화면 안의 적을 자동으로 조준해 사격 */
  private tryUlt(): void {
    const ctx = this.ctx;
    const ab = this.hero.abilities.ult;
    if (this.ultActive || this.ultCharge < ab.chargeNeeded) return;
    this.ultCharge = 0;
    this.ultReadyAnnounced = false;
    this.ultUntil = ctx.now + ab.duration;
    this.stats.ults++;
    this.weapon.reset(); // 발동 시 즉시 재장전
    ctx.sfx.ultActivate();
    ctx.hud.killFeed('전술 조준 발동!', 'hs');
    ctx.onNoise(this.ctrl.pos, 40);
  }

  /** 화면 안 + 시야선이 열린 적, 조준점에 가까운 순 */
  private lockTargets(): LockTarget[] {
    const ctx = this.ctx;
    const cam = this.camera;
    cam.getWorldDirection(this.camDir);
    const out: LockTarget[] = [];
    for (const b of ctx.bots) {
      if (!b.alive) continue;
      const point = b.position.clone();
      point.y += 1.0 * b.scale;
      const ndc = point.clone().project(cam);
      if (ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
      if (point.distanceTo(cam.position) > this.weapon.def.range) continue;
      if (losBlocked(cam.position, point, ctx.map.meshes)) continue;
      out.push({ bot: b, point, angle: angleBetweenDeg(this.camDir, point.clone().sub(cam.position)) });
    }
    out.sort((x, y) => x.angle - y.angle);
    return out;
  }

  // ---------- 사격 ----------

  private totalSpread(): number {
    const moving = this.lastMoved > 0.001 ? 0.8 : 0;
    const air = this.ctrl.onGround ? 0 : 1.5;
    const sprint = this.sprinting ? this.hero.abilities.sprint.spreadAdd : 0;
    return this.weapon.spread + moving + air + sprint;
  }

  private fire(): void {
    const ctx = this.ctx;
    const now = ctx.now;
    if (!this.weapon.fire(now)) return;
    this.stats.shots++;
    this.recoil = 1;

    const origin = this.camera.position;
    let locked = false;
    if (this.ultActive) {
      const t = this.lockTargets()[0];
      if (t) {
        this.shotDir.copy(t.point).sub(origin).normalize();
        locked = true;
      }
    }
    if (!locked) {
      this.camera.getWorldDirection(this.shotDir);
      jitterDirection(this.shotDir.clone(), this.totalSpread(), this.shotDir);
    }
    const res = hitscan(this.aimFrom(this.shotDir), this.shotDir, this.weapon.def.range, ctx.map.meshes, ctx.hittables(), this);

    this.fxMuzzlePosition(this.tmp);
    const hitColor = res.target ? 0xff7a4a : 0xffd27a;
    ctx.fx.bolt(this.tmp, res.point, this.ultActive ? 0xffd9a0 : 0x8ec5ff, hitColor, res.target ? 6 : 3, 150, res.normal, 9);
    ctx.fx.muzzleFlash(3.5);
    ctx.fx.muzzleSprite(this.tmp, 0.26, res.point.clone().sub(this.tmp).normalize(), this.ultActive ? 0xffd9a0 : 0xbfe6ff);
    ctx.sfx.shoot();
    ctx.onNoise(this.ctrl.pos, 25);

    if (res.target) {
      // 전술 조준 중에는 몸통 판정(치명타 없음)
      const headshot = res.part === 'head' && !locked;
      const dmg = computeDamage(this.weapon.def, res.distance, headshot);
      res.target.takeDamage({ amount: dmg, headshot, from: this.ctrl.pos, attacker: this });
      this.stats.hits++;
      if (headshot) this.stats.headshots++;
      if (!this.ultActive) this.ultCharge = Math.min(this.hero.abilities.ult.chargeNeeded, this.ultCharge + dmg * this.hero.abilities.ult.chargePerDamage);
      ctx.hud.hitmarkerFlash(!res.target.alive ? 'kill' : headshot ? 'hs' : 'hit', headshot);
      ctx.hud.damageNumber(res.point, this.camera, dmg, headshot);
      if (headshot) {
        // 머리에 맞은 자리에서 붉은 불꽃이 튄다
        ctx.fx.sparks(res.point, 0xff5038, 9);
        ctx.sfx.headshot();
      } else ctx.sfx.hit();
    }
  }

  takeDamage(info: DamageInfo): void {
    const ctx = this.ctx;
    if (!this.alive || ctx.now < this.invulnUntil) return;
    this.hp -= info.amount;
    this.stats.damageTaken += info.amount;
    ctx.sfx.hurt();
    const ax = info.from.x - this.ctrl.pos.x;
    const az = info.from.z - this.ctrl.pos.z;
    const fwd = ax * this.forward.x + az * this.forward.z;
    const rgt = ax * this.right.x + az * this.right.z;
    ctx.hud.damageDirection(Math.atan2(rgt, fwd));
    ctx.hud.setHp(this.hp, this.hero.hp);
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.stats.deaths++;
      this.stats.streak = 0;
      this.viewmodel.visible = false;
      this.beginDeathCam(info.from);
      this.ultUntil = 0;
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
      ctx.hud.setUlt((this.ultCharge / this.hero.abilities.ult.chargeNeeded) * 100, false, 0);
      ctx.hud.setLockMarkers([], this.camera);
      ctx.sfx.death();
      ctx.onPlayerDied(info.attacker?.displayName ?? '???');
    }
  }
}

import {
  ACESFilmicToneMapping, Color, DirectionalLight, Fog, HemisphereLight, PCFSoftShadowMap, PerspectiveCamera, Scene, Vector3,
  WebGLRenderer,
} from 'three';
import { Input } from './Input';
import { ASSET_BASE, loadAssets, type LoadedAssets } from './Assets';
import { Autopilot, AUTOPILOT_PROFILES, type AutopilotProfile } from '@/dev/Autopilot';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Sfx } from './Sfx';
import type { GameContext } from './Context';
import { GreyboxMap } from '@/world/GreyboxMap';
import { NavGrid } from '@/ai/NavGrid';
import { Fx } from '@/render/Fx';
import { Hud } from '@/ui/Hud';
import { Player } from '@/entities/Player';
import type { Bot } from '@/entities/Bot';
import { WaveManager } from '@/world/WaveManager';
import { HealthPack } from '@/world/HealthPack';
import type { Projectile } from '@/combat/Projectile';
import { DIFFICULTIES, type DifficultyId } from '@/data/difficulty';
import { PLAYER_LIVES, RESPAWN_SECONDS, SCORE } from '@/data/waves';
import type { Hittable } from '@/combat/Hitscan';

type GameState = 'menu' | 'playing' | 'paused' | 'dead' | 'ended';

const FIXED_DT = 1 / 60;
/** 뷰모델(총·팔) 전용 수직 FOV */

export class Game {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly input: Input;
  private readonly hud = new Hud();
  private readonly sfx = new Sfx();
  private readonly fx: Fx;
  private readonly map = new GreyboxMap();
  private readonly nav: NavGrid;
  private readonly player: Player;
  private readonly bots: Bot[] = [];
  private readonly packs: HealthPack[] = [];
  private projectiles: Projectile[] = [];
  private readonly waves: WaveManager;
  private readonly ctx: GameContext;

  private state: GameState = 'menu';
  private difficultyId: DifficultyId = 'normal';
  private simTime = 0;
  private accumulator = 0;
  private lastFrame = 0;
  private lives = PLAYER_LIVES;
  private score = 0;
  private respawnAt = 0;
  /** 사망 오버레이는 쓰러지는 연출이 보이도록 잠시 뒤에 띄운다 */
  private deadOverlayAt = 0;
  private debug = false;
  private startedAt = 0;
  assets: LoadedAssets | null = null;
  /** F8 오토파일럿 (플레이테스트/데모) */
  autopilot: Autopilot | null = null;
  /** 웨이브 클리어 스냅샷 (플레이테스트 로그) */
  readonly waveLog: { wave: number; time: number; deaths: number; kills: number; shots: number; hits: number; damageTaken: number; hp: number }[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.05, 400);
    this.scene.add(this.camera);
    this.scene.background = new Color(0x9fc5ff);
    this.scene.fog = new Fog(0x9fc5ff, 90, 220);

    const hemi = new HemisphereLight(0xcfe3ff, 0x40464f, 0.9);
    const sun = new DirectionalLight(0xfff1dc, 1.8);
    sun.position.set(35, 60, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -50;
    sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 150;
    sun.shadow.bias = -0.0005;
    hemi.layers.enable(Player.VIEWMODEL_LAYER);
    sun.layers.enable(Player.VIEWMODEL_LAYER);
    this.scene.add(hemi, sun);

    this.scene.add(this.map.group);
    this.nav = new NavGrid(this.map);
    this.fx = new Fx(this.scene);
    this.fx.enableViewmodelLayer();
    this.input = new Input(this.renderer.domElement);
    this.player = new Player(this.map.colliders, this.camera);
    this.scene.add(this.player.hitGroup);
    for (const spot of this.map.healthPackSpots) {
      const pack = new HealthPack(spot.pos, spot.big);
      this.packs.push(pack);
      this.scene.add(pack.group);
    }

    const self = this;
    this.ctx = {
      scene: this.scene,
      camera: this.camera,
      map: this.map,
      nav: this.nav,
      fx: this.fx,
      hud: this.hud,
      sfx: this.sfx,
      get input() { return self.autopilot ?? self.input; },
      get difficulty() { return DIFFICULTIES[self.difficultyId]; },
      player: this.player,
      bots: this.bots,
      packs: this.packs,
      get assets() { return self.assets; },
      now: 0,
      get debug() { return self.debug; },
      hittables: (): Hittable[] => [this.player, ...this.bots],
      onBotKilled: (bot, headshot) => this.onBotKilled(bot, headshot),
      onPlayerDied: (by) => this.onPlayerDied(by),
      onNoise: (pos, radius) => this.onNoise(pos, radius),
      spawnProjectile: (p) => this.projectiles.push(p),
    };
    this.player.ctx = this.ctx;
    this.waves = new WaveManager(this.ctx, (n, noDeath) => this.onWaveClear(n, noDeath), () => this.endGame(true));

    this.bindUi();
    window.addEventListener('resize', () => this.onResize());
    this.input.onLockChange = (locked) => this.onLockChange(locked);
    this.input.onLockFailed = () => this.hud.killFeed('이 브라우저는 Pointer Lock을 지원하지 않아 마우스 시점이 동작하지 않습니다', 'death');
    this.player.spawn(this.map.playerSpawn, 0);
    this.hud.showOverlay('ov-menu');
    requestAnimationFrame((t) => this.frame(t));
    void this.loadAssets();
  }

  /** M3 에셋 로드: 실패하거나 없으면 그레이박스 유지 */
  private async loadAssets(): Promise<void> {
    const startBtn = document.getElementById('btn-start') as HTMLButtonElement | null;
    try {
      if (startBtn) startBtn.textContent = '에셋 로딩 중…';
      const a = await loadAssets();
      this.assets = a;
      if (a.sky) {
        this.scene.background = a.sky;
        this.scene.environment = a.sky;
        this.scene.fog = new Fog(0xbcd6ff, 120, 260);
      }
      this.map.applyTextures(a.floor, a.container);
      if (a.rifle) this.player.applyRifleModel(a.rifle);
      if (a.fpRig) this.player.applyFpRig(a.fpRig.scene, a.fpRig.clips);
      else if (a.fpArms) this.player.applyFpArmsModel(a.fpArms);
      this.fx.setTextures(a.vfx);
      this.warmupShaders(a);
      const clips = await this.sfx.loadBank(ASSET_BASE, this.camera);
      console.info(`[Assets] sfx clips: ${clips}`);
      console.info('[Assets] loaded', { sky: !!a.sky, floor: !!a.floor, container: !!a.container, raven: !!a.raven, clips: a.raven ? Object.keys(a.raven.clips) : [], rifle: !!a.rifle });
    } catch (e) {
      console.warn('[Assets] load failed, keeping greybox', e);
    } finally {
      if (startBtn) startBtn.textContent = '클릭하여 시작';
      // 로드 전 민짜 장면이 비치지 않도록 불투명했던 메뉴를 반투명으로
      document.getElementById('ov-menu')?.classList.remove('loading');
    }
  }

  // ---------- UI ----------

  private bindUi(): void {
    const diffBtns = document.querySelectorAll<HTMLButtonElement>('#difficulty .btn');
    diffBtns.forEach((b) =>
      b.addEventListener('click', () => {
        diffBtns.forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        this.difficultyId = (b.dataset.d as DifficultyId) ?? 'normal';
      }),
    );
    document.getElementById('btn-start')?.addEventListener('click', () => this.startGame());
    document.getElementById('btn-restart')?.addEventListener('click', () => this.startGame());
    document.getElementById('btn-resume')?.addEventListener('click', () => this.input.requestLock());
    // 오버레이 자체 클릭으로도 재개
    document.getElementById('ov-pause')?.addEventListener('click', () => this.input.requestLock());
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private onLockChange(locked: boolean): void {
    if (locked) {
      if (this.state === 'paused') {
        this.state = 'playing';
        this.hud.showOverlay(null);
      }
    } else if ((this.state === 'playing' || this.state === 'dead') && !this.autopilot) {
      this.state = 'paused';
      this.hud.showOverlay('ov-pause');
    }
  }

  // ---------- 흐름 ----------

  private startGame(): void {
    this.sfx.init();
    for (const b of this.bots) {
      this.scene.remove(b.group, b.debugLine);
    }
    this.bots.length = 0;
    this.fx.clear();
    for (const pk of this.packs) pk.reset();
    for (const pr of this.projectiles) pr.dispose();
    this.projectiles = [];
    this.hud.resetFeeds();
    this.lives = PLAYER_LIVES;
    this.score = 0;
    this.simTime = 0;
    this.ctx.now = 0;
    this.startedAt = 0;
    this.player.resetStats();
    this.waveLog.length = 0;
    this.player.spawn(this.map.playerSpawn, 0);
    this.hud.setLives(this.lives);
    this.hud.setScore(this.score);
    this.hud.setVisible(true);
    this.hud.showOverlay(null);
    this.state = 'playing';
    this.waves.start();
    this.input.requestLock();
  }

  private onWaveClear(n: number, noDeath: boolean): void {
    const st = this.player.stats;
    this.waveLog.push({ wave: n, time: this.simTime, deaths: st.deaths, kills: st.kills, shots: st.shots, hits: st.hits, damageTaken: st.damageTaken, hp: this.player.hp });
    if (noDeath) {
      this.score += SCORE.waveNoDeath;
      this.hud.killFeed(`WAVE ${n} 노데스 클리어 +${SCORE.waveNoDeath}`, 'hs');
    } else this.hud.killFeed(`WAVE ${n} 클리어`);
    this.hud.setScore(this.score);
  }

  private onBotKilled(bot: Bot, headshot: boolean): void {
    const s = this.player.stats;
    s.kills++;
    s.streak++;
    s.maxStreak = Math.max(s.maxStreak, s.streak);
    this.score += bot.isBoss ? SCORE.bossKill : headshot ? SCORE.headshotKill : SCORE.kill;
    this.hud.setScore(this.score);
    this.hud.killFeed(`YOU ▶ ${bot.displayName}${headshot ? ' (헤드샷)' : ''}${bot.isBoss ? ' +500' : ''}`, headshot || bot.isBoss ? 'hs' : '');
    if (bot.isBoss) this.hud.setBoss(null);
    this.hud.setBots(this.waves.aliveBots);
    this.sfx.kill();
  }

  private onPlayerDied(by: string): void {
    this.lastKillerName = by;
    this.lives--;
    this.waves.playerDiedThisWave = true;
    this.hud.setLives(this.lives);
    this.hud.killFeed(`${by} ▶ YOU`, 'death');
    if (this.lives <= 0) {
      this.endGame(false);
      return;
    }
    this.state = 'dead';
    this.respawnAt = this.simTime + RESPAWN_SECONDS;
    this.deadOverlayAt = this.simTime + 0.6;
    this.hud.setDead(by, RESPAWN_SECONDS);
  }

  private respawn(): void {
    this.player.spawn(this.map.playerSpawn, this.simTime);
    this.state = 'playing';
    this.hud.showOverlay(null);
  }

  private endGame(victory: boolean): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    document.exitPointerLock();
    const s = this.player.stats;
    const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
    const hsr = s.hits ? Math.round((s.headshots / s.hits) * 100) : 0;
    const elapsed = Math.round(this.simTime - this.startedAt);
    this.hud.setEnd(victory, victory ? `웨이브 ${this.waves.totalWaves}개 모두 섬멸 · ${this.ctx.difficulty.label}` : `웨이브 ${this.waves.waveNumber}에서 전멸 · ${this.ctx.difficulty.label}`, [
      ['점수', String(this.score)],
      ['처치', String(s.kills)],
      ['사망', String(s.deaths)],
      ['명중률', `${acc}%`],
      ['헤드샷 비율', `${hsr}%`],
      ['최대 연속 처치', String(s.maxStreak)],
      ['펄스 로켓 / 치유 필드 / 궁', `${s.rockets} / ${s.fields} / ${s.ults}`],
      ['플레이 시간', `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`],
    ]);
    this.hud.showOverlay('ov-end');
  }

  private onNoise(pos: Vector3, radius: number): void {
    for (const b of this.bots) {
      if (b.alive && b.position.distanceTo(pos) <= radius) b.hear(pos);
    }
  }

  // ---------- 루프 ----------

  private frame(t: number): void {
    requestAnimationFrame((n) => this.frame(n));
    const dt = Math.min(0.1, (t - this.lastFrame) / 1000 || 0);
    this.lastFrame = t;

    if (this.input.justPressed('F8')) this.setAutopilot(this.autopilot ? null : 'average');
    if (this.input.justPressed('F3')) {
      this.debug = !this.debug;
      for (const b of this.bots) b.setDebug(this.debug);
      if (!this.debug) this.hud.clearBotLabels();
    }

    // 키 "방금 눌림"은 시뮬레이션 스텝이 실제로 소비한 뒤에만 지운다.
    // 렌더 프레임마다 지우면 스텝이 없는 프레임(고주사율 모니터)에서 점프·스킬 입력이 유실된다.
    let consumedInput = true;
    if (this.state === 'playing' || this.state === 'dead') {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 5) {
        this.step(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      consumedInput = steps > 0;
    } else {
      // 메뉴/일시정지: 마우스 누적 폐기
      this.input.consumeMouse();
    }

    this.fx.camPos.copy(this.camera.position);
    this.fx.update(dt);
    if (this.debug && this.state !== 'menu') {
      const items = this.bots.filter((b) => b.alive).map((b) => ({ world: b.position.clone().setY(b.position.y + 2.1), text: b.debugText() }));
      this.hud.setBotLabels(items, this.camera);
      for (const b of this.bots) b.setDebug(true);
    }
    this.renderFrame();
    if (consumedInput) this.input.endFrame();
  }

  /** 월드 패스 → 깊이 버퍼 비움 → 뷰모델 패스. 1인칭 총이 벽을 뚫고 보이지 않게 한다 */
  private renderFrame(): void {
    const r = this.renderer;
    this.camera.layers.set(0);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    const bg = this.scene.background;
    this.scene.background = null;
    r.autoClear = false;
    r.clearDepth();
    // 뷰모델 전용 FOV: 가까운 총·팔의 원근 왜곡을 줄인다 (일반 FPS 관례)
    const worldFov = this.camera.fov;
    this.camera.fov = Player.VIEWMODEL_FOV;
    this.camera.updateProjectionMatrix();
    this.camera.layers.set(Player.VIEWMODEL_LAYER);
    r.render(this.scene, this.camera);
    this.camera.layers.set(0);
    this.camera.fov = worldFov;
    this.camera.updateProjectionMatrix();
    this.scene.background = bg;
    r.autoClear = true;
  }

  /**
   * 셰이더 사전 컴파일: 효과·봇 모델 재질을 로딩 단계에서 한 번 컴파일해 전투 중 멈춤을 없앤다
   */
  private warmupShaders(a: LoadedAssets): void {
    const t0 = performance.now();
    let dummy: import('three').Object3D | null = null;
    const skinned = a.botRig?.scene ?? a.raven?.scene;
    if (skinned) {
      // 스킨드 메시 전용 셰이더 변형도 미리 컴파일
      dummy = SkeletonUtils.clone(skinned);
      dummy.position.set(0, -200, 0);
      this.scene.add(dummy);
    }
    this.fx.warmup(this.renderer, this.camera);
    if (dummy) this.scene.remove(dummy);
    console.info(`[Assets] shader warmup ${Math.round(performance.now() - t0)}ms`);
  }

  /** 오토파일럿 켜기/끄기 */
  setAutopilot(profile: keyof typeof AUTOPILOT_PROFILES | AutopilotProfile | null): void {
    if (!profile) {
      this.autopilot = null;
      this.hud.killFeed('오토파일럿 OFF');
      return;
    }
    const prof = typeof profile === 'string' ? AUTOPILOT_PROFILES[profile] : profile;
    this.autopilot = new Autopilot(this.ctx, prof);
    this.hud.killFeed(`오토파일럿 ON (${typeof profile === 'string' ? profile : 'custom'})`, 'hs');
  }

  private step(dt: number): void {
    this.simTime += dt;
    this.ctx.now = this.simTime;
    if (this.state === 'playing') {
      if (this.autopilot) {
        this.autopilot.think(dt);
        this.player.update(dt, this.autopilot);
        this.autopilot.endFrame();
      } else this.player.update(dt, this.input);
    }
    else {
      this.input.consumeMouse();
      this.player.updateDeathCam(dt);
      if (this.simTime >= this.deadOverlayAt) this.hud.showOverlay('ov-dead');
      const left = Math.max(0, this.respawnAt - this.simTime);
      this.hud.setDead(this.lastKiller(), Math.ceil(left));
      if (left <= 0) this.respawn();
    }
    this.assignAttackTokens();
    for (const b of this.bots) b.update(dt);
    for (const pr of this.projectiles) pr.update(dt);
    if (this.projectiles.some((p) => p.done)) this.projectiles = this.projectiles.filter((p) => !p.done);
    this.updatePacks(dt);
    this.waves.update();
  }

  /** 공격 토큰 배분: 플레이어가 보이는 봇 중 가까운 순으로 난이도별 N명만 사격 허용 */
  private assignAttackTokens(): void {
    const n = this.ctx.difficulty.attackTokens;
    const p = this.player.position;
    const seeing = this.bots.filter((b) => b.alive && b.seesPlayer && !b.isBoss);
    seeing.sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p));
    for (const b of this.bots) b.hasAttackToken = false;
    for (let i = 0; i < Math.min(n, seeing.length); i++) seeing[i].hasAttackToken = true;
  }

  private updatePacks(dt: number): void {
    for (const pk of this.packs) {
      pk.update(this.simTime, dt);
      if (!pk.active) continue;
      if (this.player.alive) {
        const healed = pk.tryPickup(this.player, this.simTime);
        if (healed > 0) {
          this.hud.healNumber(healed);
          this.hud.setHp(this.player.hp, this.player.maxHp);
          this.sfx.heal();
          continue;
        }
      }
      for (const b of this.bots) {
        if (b.alive && pk.tryPickup(b, this.simTime) > 0) break;
      }
    }
  }

  private lastKillerName = '???';
  private lastKiller(): string {
    return this.lastKillerName;
  }
}

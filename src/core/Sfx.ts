/**
 * 효과음 파사드.
 * - 기본: 레이어드 신디사이즈(SynthSfx) — 일관된 미래풍, 타이트한 타격감
 * - 보조: 힉스필드 생성 클립(AudioBank)을 큰 순간(섬광탄·궁·웨이브·사망)에만 레이어로 섞는다
 */
import { AudioBank, type SfxName } from './AudioBank';
import { SynthSfx } from './SynthSfx';
import type { Camera, Vector3 } from 'three';

/** 생성 클립을 레이어로 섞을 때의 볼륨 (0이면 합성음만) */
const CLIP_LAYER: Partial<Record<SfxName, number>> = {
  flashbang: 0.55,
  ult_activate: 0.5,
  wave_clear: 0.4,
  death: 0.5,
  bot_death: 0.45,
  dash: 0.3,
  footstep: 0.7,
  land: 0.8,
  reload_out: 0.7,
  reload_in: 0.8,
};

/** 생성 클립이 같이 날 때 합성음 쪽을 줄이는 비율 (둘이 겹쳐 뭉개지지 않게) */
const SYNTH_UNDER_CLIP = 0.6;

export class Sfx {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  bank: AudioBank | null = null;
  synth: SynthSfx | null = null;
  private listener: Camera | null = null;
  private lastShot = 0;

  /** 컨텍스트 생성(제스처 전엔 suspended). 사용자 제스처 후 다시 호출하면 resume */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.3;
    // 마스터 컴프레서: 연사·동시 효과에서 과도한 피크 방지
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(this.ctx.destination);
    this.bank = new AudioBank(this.ctx, this.master);
    this.synth = new SynthSfx(this.ctx, this.master);
  }

  /** 생성 효과음 로드 (manifest 기반). 로드된 클립 수 반환 */
  async loadBank(baseUrl: string, listener: Camera): Promise<number> {
    this.init();
    this.listener = listener;
    if (!this.bank) return 0;
    this.bank.setListener(listener);
    return this.bank.load(baseUrl);
  }

  private rnd(spread = 0.08): number {
    return 1 + (Math.random() * 2 - 1) * spread;
  }

  /** 생성 클립 레이어 (있을 때만). 재생했으면 true */
  private layer(name: SfxName, pos?: Vector3, scale = 1, spread = 0.05): boolean {
    const v = (CLIP_LAYER[name] ?? 0) * scale;
    if (!v || !this.bank) return false;
    if (pos) return this.bank.playAt(name, pos, v, this.rnd(spread));
    return this.bank.play(name, v, this.rnd(spread));
  }

  /** 이 이름의 생성 클립을 레이어로 쓸 수 있는가 */
  private hasLayer(name: SfxName): boolean {
    return !!CLIP_LAYER[name] && !!this.bank?.has(name);
  }

  /** 리스너 갱신 후 3D 패너 생성 */
  private pannerAt(pos: Vector3): AudioNode | null {
    if (!this.synth || !this.ctx) return null;
    if (this.listener && this.bank) this.bank.updateListenerFrom(this.listener);
    return this.synth.panner(pos);
  }

  /** 3D 위치 재생 (AudioBank 호환용) */
  playAt(name: SfxName, pos: Vector3, vol = 1, rate = 1): boolean {
    return this.bank?.playAt(name, pos, vol, rate) ?? false;
  }

  // ---------- 무기 ----------

  shoot(): void {
    if (!this.synth || !this.ctx) return;
    // 같은 프레임 다중 호출 방지
    if (this.ctx.currentTime - this.lastShot < 0.04) return;
    this.lastShot = this.ctx.currentTime;
    this.synth.pulseShot(undefined, this.rnd(0.05), 1);
  }

  shootFar(vol = 0.25, pos?: Vector3): void {
    if (!this.synth) return;
    const dst = pos ? this.pannerAt(pos) : null;
    this.synth.pulseShotFar(dst ?? this.synth.destination, this.rnd(0.07), pos ? 1 : vol * 2.5);
  }

  hit(): void {
    this.synth?.hit();
  }

  headshot(): void {
    this.synth?.headshot();
  }

  kill(): void {
    this.synth?.kill();
  }

  hurt(): void {
    this.synth?.hurt();
  }

  /**
   * 재장전 효과음. 1인칭 재장전 애니메이션의 동작 시점마다 한 단계씩 부른다.
   * 0 = 탄창 분리, 1 = 새 탄창 삽입, 2 = 왼손 복귀(장전 완료)
   */
  reloadStage(stage: number): void {
    if (!this.synth) return;
    if (stage === 0) {
      this.synth.reloadOut(this.hasLayer('reload_out') ? SYNTH_UNDER_CLIP : 1);
      this.layer('reload_out');
    } else if (stage === 1) {
      this.synth.reloadIn(this.hasLayer('reload_in') ? SYNTH_UNDER_CLIP : 1);
      this.layer('reload_in');
    } else this.synth.reloadReady();
  }

  empty(): void {
    this.synth?.empty();
  }

  // ---------- 이동 ----------

  jump(): void {
    this.synth?.jump();
  }

  footstep(pos?: Vector3, vol = 0.35): void {
    if (!this.synth) return;
    const k = this.hasLayer('footstep') ? SYNTH_UNDER_CLIP : 1;
    if (pos) {
      const dst = this.pannerAt(pos);
      this.synth.footstep(dst ?? this.synth.destination, vol * 1.6 * k, this.rnd(0.12));
      this.layer('footstep', pos, 1.3, 0.1);
    } else {
      this.synth.footstep(undefined, vol * k, this.rnd(0.12));
      this.layer('footstep', undefined, vol / 0.3, 0.1);
    }
  }

  /** 착지. impact 0..1 = 떨어진 속도에 비례한 세기 */
  land(impact = 1): void {
    if (!this.synth) return;
    this.synth.footstep(undefined, 0.4 * (this.hasLayer('land') ? SYNTH_UNDER_CLIP : 1), this.rnd(0.08) * 0.85);
    this.layer('land', undefined, 0.5 + 0.5 * impact, 0.06);
  }

  botDeath(pos: Vector3): void {
    if (!this.synth) return;
    const dst = this.pannerAt(pos);
    this.synth.botDeath(dst ?? this.synth.destination, 1);
    this.layer('bot_death', pos);
  }

  // ---------- 스킬 ----------

  rocketFire(): void {
    this.synth?.rocketFire();
  }

  rocketExplode(pos: Vector3): void {
    if (!this.synth) return;
    const dst = this.pannerAt(pos);
    this.synth.rocketExplode(dst ?? this.synth.destination, 1.2);
  }

  healField(): void {
    this.synth?.healField();
  }

  dash(): void {
    this.synth?.dash();
    this.layer('dash');
  }

  throwItem(): void {
    this.synth?.throwItem();
  }

  flashBang(): void {
    this.synth?.flashbang();
    this.layer('flashbang');
  }

  ultActivate(): void {
    this.synth?.ultActivate();
    this.layer('ult_activate');
  }

  ultReady(): void {
    this.synth?.ultReady();
  }

  heal(): void {
    this.synth?.heal();
  }

  // ---------- 흐름 ----------

  waveStart(): void {
    this.synth?.waveStart();
    this.layer('wave_start');
  }

  waveClear(): void {
    this.synth?.waveClear();
    this.layer('wave_clear');
  }

  death(): void {
    this.synth?.death();
    this.layer('death');
  }
}

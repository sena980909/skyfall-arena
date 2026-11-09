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
};

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

  /** 생성 클립 레이어 (있을 때만) */
  private layer(name: SfxName, pos?: Vector3): void {
    const v = CLIP_LAYER[name];
    if (!v || !this.bank) return;
    if (pos) this.bank.playAt(name, pos, v, this.rnd(0.05));
    else this.bank.play(name, v, this.rnd(0.05));
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

  reload(): void {
    this.synth?.reload();
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
    if (pos) {
      const dst = this.pannerAt(pos);
      this.synth.footstep(dst ?? this.synth.destination, vol * 1.6, this.rnd(0.12));
    } else this.synth.footstep(undefined, vol, this.rnd(0.12));
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

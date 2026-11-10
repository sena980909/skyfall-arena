import { ENEMIES, type EnemyKind } from '@/data/enemies';
import { Vector3 } from 'three';
import { Bot } from '@/entities/Bot';
import { WAVE_REST_SECONDS, WAVES } from '@/data/waves';
import type { GameContext } from '@/core/Context';

export type WaveState = 'idle' | 'active' | 'rest' | 'done';

/** 웨이브 진행/스폰 관리 — GDD 3.1 */
export class WaveManager {
  waveIndex = -1;
  state: WaveState = 'idle';
  playerDiedThisWave = false;
  private restEnd = 0;
  /** 스폰 큐: [시각, 보스 여부] */
  private spawnQueue: [number, boolean, EnemyKind][] = [];
  boss: Bot | null = null;
  private lastSpawnIdx = -1;
  private botCounter = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly onWaveClear: (waveNumber: number, noDeath: boolean) => void,
    private readonly onVictory: () => void,
  ) {}

  get totalWaves(): number {
    return WAVES.length;
  }

  get waveNumber(): number {
    return this.waveIndex + 1;
  }

  get aliveBots(): number {
    return this.ctx.bots.filter((b) => b.alive).length + this.spawnQueue.length;
  }

  reset(): void {
    this.waveIndex = -1;
    this.state = 'idle';
    this.spawnQueue = [];
    this.botCounter = 0;
    this.boss = null;
    this.ctx.hud.setRest('');
    this.ctx.hud.setBoss(null);
  }

  start(): void {
    this.reset();
    this.nextWave();
  }

  private nextWave(): void {
    this.waveIndex++;
    if (this.waveIndex >= WAVES.length) {
      this.state = 'done';
      this.onVictory();
      return;
    }
    const def = WAVES[this.waveIndex];
    this.state = 'active';
    this.playerDiedThisWave = false;
    // 이전 웨이브의 죽은 봇 정리
    for (const b of this.ctx.bots) {
      this.ctx.scene.remove(b.debugLine);
    }
    this.ctx.bots.length = 0;
    this.boss = null;
    this.spawnQueue = [];
    if (def.boss) this.spawnQueue.push([this.ctx.now + 0.6, true, 'trooper']);
    // 돌격병이 먼저 나오고 돌입병·저격병이 뒤따른다
    const marksmen = def.marksmen ?? 0;
    const rushers = def.rushers ?? 0;
    for (let i = 0; i < def.bots; i++) {
      const k = def.bots - 1 - i;
      const kind: EnemyKind = k < marksmen ? 'marksman' : k < marksmen + rushers ? 'rusher' : 'trooper';
      this.spawnQueue.push([this.ctx.now + 0.6 + (i + (def.boss ? 1 : 0)) * 0.5, false, kind]);
    }
    this.ctx.hud.setWave(this.waveNumber, WAVES.length);
    this.ctx.hud.setBots(this.aliveBots);
    this.ctx.hud.setRest('');
    this.ctx.hud.setBoss(null);
    this.ctx.hud.killFeed(def.boss ? `WAVE ${this.waveNumber} — 보스 출현! 호위 ${def.bots}` : `WAVE ${this.waveNumber} 시작 — 봇 ${def.bots}`, def.boss ? 'death' : '');
    this.ctx.sfx.waveStart();
  }

  private pickSpawn(): Vector3 {
    const spawns = this.ctx.map.botSpawns;
    const p = this.ctx.player.position;
    const candidates = spawns
      .map((s, i) => ({ s, i, d: s.distanceTo(p) }))
      .filter((c) => c.d >= 25 && c.i !== this.lastSpawnIdx);
    const pool = candidates.length ? candidates : spawns.map((s, i) => ({ s, i, d: 0 }));
    const c = pool[Math.floor(Math.random() * pool.length)];
    this.lastSpawnIdx = c.i;
    // 겹침 방지 소량 오프셋
    return c.s.clone().add(new Vector3((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5));
  }

  private spawnBot(isBoss: boolean, kind: EnemyKind): void {
    const def = WAVES[this.waveIndex];
    let bot: Bot;
    if (isBoss && def.boss) {
      bot = new Bot(this.ctx, def.boss.name, this.pickSpawn(), { hpMult: def.boss.hpMult, scale: def.boss.scale, boss: true });
      this.boss = bot;
    } else {
      this.botCounter++;
      bot = new Bot(this.ctx, `${ENEMIES[kind].label} ${this.botCounter}`, this.pickSpawn(), { kind });
    }
    this.ctx.bots.push(bot);
    this.ctx.scene.add(bot.group, bot.debugLine);
    bot.setDebug(this.ctx.debug);
    this.ctx.hud.setBots(this.aliveBots);
  }

  update(): void {
    const now = this.ctx.now;
    if (this.state === 'active') {
      while (this.spawnQueue.length && now >= this.spawnQueue[0][0]) {
        const [, isBoss, kind] = this.spawnQueue.shift() as [number, boolean, EnemyKind];
        this.spawnBot(isBoss, kind);
      }
      if (this.boss) {
        this.ctx.hud.setBoss(this.boss.alive ? { name: this.boss.displayName, hp: this.boss.hp, max: this.boss.maxHp } : null);
      }
      if (this.spawnQueue.length === 0 && this.ctx.bots.every((b) => !b.alive)) {
        const last = this.waveIndex >= WAVES.length - 1;
        this.ctx.sfx.waveClear();
        this.onWaveClear(this.waveNumber, !this.playerDiedThisWave);
        if (last) {
          this.state = 'done';
          this.onVictory();
        } else {
          this.state = 'rest';
          this.restEnd = now + WAVE_REST_SECONDS;
        }
      }
    } else if (this.state === 'rest') {
      const left = Math.max(0, this.restEnd - now);
      this.ctx.hud.setRest(`웨이브 클리어! 다음 웨이브까지 ${Math.ceil(left)}초`);
      if (now >= this.restEnd) this.nextWave();
    }
  }
}

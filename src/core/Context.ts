import type { PerspectiveCamera, Scene } from 'three';
import type { GreyboxMap } from '@/world/GreyboxMap';
import type { NavGrid } from '@/ai/NavGrid';
import type { Fx } from '@/render/Fx';
import type { Hud } from '@/ui/Hud';
import type { Sfx } from '@/core/Sfx';
import type { DifficultyDef } from '@/data/difficulty';
import type { Hittable } from '@/combat/Hitscan';
import type { Player } from '@/entities/Player';
import type { Bot } from '@/entities/Bot';
import type { HealthPack } from '@/world/HealthPack';
import type { PlayerInput } from '@/core/PlayerInput';
import type { FlashGrenade } from '@/combat/FlashGrenade';
import type { LoadedAssets } from '@/core/Assets';

/** 엔티티가 월드와 상호작용할 때 쓰는 공용 컨텍스트 */
export interface GameContext {
  scene: Scene;
  camera: PerspectiveCamera;
  map: GreyboxMap;
  nav: NavGrid;
  fx: Fx;
  hud: Hud;
  sfx: Sfx;
  input: PlayerInput;
  difficulty: DifficultyDef;
  player: Player;
  bots: Bot[];
  packs: HealthPack[];
  /** M3 에셋 (로드 전/실패 시 null) */
  assets: LoadedAssets | null;
  /** 현재 시뮬레이션 시간 (초) */
  now: number;
  debug: boolean;
  hittables(): Hittable[];
  onBotKilled(bot: Bot, headshot: boolean): void;
  onPlayerDied(byName: string): void;
  /** 플레이어 총성 등 봇이 들을 수 있는 이벤트 */
  onNoise(position: import('three').Vector3, radius: number): void;
  spawnProjectile(p: FlashGrenade): void;
}

import { Game } from '@/core/Game';

const container = document.getElementById('app');
if (!container) throw new Error('#app not found');

// 디버깅용 전역 참조
(window as unknown as { game: Game }).game = new Game(container);

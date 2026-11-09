/** 게임 루프가 매 스텝 갱신하는 일시 오브젝트 (로켓, 치유 필드 등) */
export interface Projectile {
  done: boolean;
  update(dt: number): void;
  dispose(): void;
}

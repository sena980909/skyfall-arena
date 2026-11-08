/** 플레이어가 읽는 입력 인터페이스. 실제 키보드/마우스(Input)와 오토파일럿이 모두 구현한다 */
export interface PlayerInput {
  readonly mouseDown: boolean[];
  readonly mousePressed: boolean[];
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  consumeMouse(): { dx: number; dy: number };
  endFrame(): void;
}

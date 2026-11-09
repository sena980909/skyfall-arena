# SKYFALL ARENA

웹 브라우저용 영웅 기반 하이퍼 FPS. 싱글 플레이, AI 봇 웨이브 섬멸전.
기획은 [GDD.md](GDD.md) 참고.

**플레이:** https://sena980909.github.io/skyfall-arena/  (GitHub Pages, 데스크톱 Chrome/Edge 권장)

## 실행

```bash
npm install
npm run dev
```

브라우저에서 http://localhost:5179 접속. **Pointer Lock(마우스 잠금)이 필요하므로 일반 Chrome/Edge 탭에서 실행**해야 마우스 시점이 동작한다 (임베디드 브라우저 패널에서는 시점 회전 불가).

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 (HMR) |
| `npm run typecheck` | 타입 체크 |
| `npm run build` | 타입 체크 + 프로덕션 빌드 (`dist/`) |

## 조작

| 입력 | 동작 |
|---|---|
| WASD / Space | 이동 / 점프 |
| Shift (유지) | 달리기 (앞으로 이동 시 1.4배, 탄퍼짐 증가) |
| F / E / Q | 블링크 / 섬광탄 / 오버클럭 |
| 마우스 좌클릭 | 사격 (펄스 라이플, 히트스캔) |
| R | 재장전 |
| F3 | 봇 디버그 (상태 라벨 + 경로 라인) |
| F8 | 오토파일럿 (AI가 플레이어를 조작, 데모/플레이테스트용) |
| Esc | 일시정지 (마우스 잠금 해제) |

## 현재 상태: M3 완료 (레이븐 완성 + 에셋 1차)

M3에서 추가됨
- 레이븐 스킬: 블링크 대시(F, 8m, 쿨 5초), 섬광탄(E, 투사체, 반경 5m 봇 2초 실명, 쿨 10초), 오버클럭 궁(Q, 8초 연사 ×1.5·이속 +30%·탄약 무한)
- 궁 게이지 충전(피해 ×0.25 + 초당 1), 준비 완료 알림, 스킬 쿨다운 HUD, 섬광 화이트아웃, 궁 화면 틴트
- 힉스필드 생성 에셋: 레이븐 컨셉(A-pose), 펄스 라이플 GLB(5.3k tris, 1인칭 뷰모델), 스카이 파노라마, 바닥/컨테이너 타일 텍스처
- 에셋 로더(`src/core/Assets.ts`): 파일이 없으면 자동으로 그레이박스 폴백
- 봇 캐릭터: 레이븐 리깅 GLB + idle/run/shoot/death 클립(이동 속도·사격에 따라 전환, 사망 애니메이션 후 디졸브), 봇 팀 색(주황/보스 빨강) 틴트
- GLB 최적화 스크립트(`tools/optimize-glb.mjs`): 텍스처 1K WebP, 애니메이션 파일은 본+클립만 남김 → 모델 합계 58MB → 2.3MB
- 봇 걸음 개선: 클립 속도를 실제 이동 속도에 연동, 교전 중엔 조준 방향·비교전 시 이동 방향으로 몸통 회전, 옆걸음(strafe)·제자리 조준(aim) 클립 추가
- 탄환 효과: 순간 직선 대신 날아가는 광선(160m/s) + 총구 섬광 스프라이트 + 도착 시 스파크, 봇은 손에 든 라이플 총구에서 발사
- 그래픽 점검(2026-11-09): 봇 대기 자세를 라이플 조준 스탠스로 교체(기본 idle은 총이 옆으로 뻗음), 옆걸음 속도를 사이드스텝 클립에 맞춰 감속, 크레이트/엄폐벽 텍스처 적용
- 총 각도 보정(`src/render/GunAlign.ts`): 생성 GLB의 총열이 Z축에서 23° 틀어져 있어 정점 주축(PCA)으로 총열=-Z, 조준기=+Y 정렬. 1인칭·봇 라이플·총구 위치 모두 이 기준 사용
- 봇 라이플: 팀 색(주황/보스 빨강) 틴트. 손 본의 회전을 따르지 않고 위치만 오른손에 두고 방향은 매 프레임 조준 방향(롤 없는 lookAt)으로 정렬 → 어떤 애니메이션에서도 총열이 목표를 향함
- 효과음 3차: 생성 모델 품질 편차가 커서 레이어드 신디사이즈 엔진(`src/core/SynthSfx.ts`)을 기본으로 전환. 하이퍼 FPS 돌격 영웅의 펄스 라이플 성격(타이트한 타격 트랜지언트 + 낮은 몸통 + 약한 전자음 날, 헤드샷 '딩', 처치 '툭', 2단 클릭 재장전)을 합성으로 설계. 생성 클립은 섬광탄·궁·웨이브·사망·대시에만 레이어로 섞음(`CLIP_LAYER`). 마스터 컴프레서 + 소프트클립 + 짧은 합성 잔향
- 효과음을 힉스필드(Mirelo SFX)로 생성해 `public/assets/sfx/`에 배치 (2차: 미래풍·부드러운 합성음으로 재생성, WebAudio 분석으로 거친/무음 클립 걸러 14종 채택, 6종은 합성음 유지). 뱅크 버스에 컴프레서, 클립별 RMS 정규화(목표 0.2)·가장자리 페이드, 마스터 0.28. 사실상 무음인 생성 클립(rms<0.02)은 로드 시 자동 제외되어 합성음으로 폴백. `game.sfx.bank.report(0.28)`로 클립별 출력 dBFS 확인 가능.
- 스파크/섬광 구체(6분할 저폴리)가 근거리에서 각진 팔각형으로 보이던 것을 부드러운 점 스프라이트로 교체, 섬광탄 폭발의 거대 구체 제거 `AudioBank`가 manifest 기반으로 로드하고 봇 총성·발소리·사망음은 3D 위치 재생(PannerNode), 파일이 없으면 기존 합성음 폴백
- 탄환/스킬 VFX 텍스처(총구 섬광·탄환 광선·임팩트 4x4 시트·섬광탄 폭발)를 힉스필드로 생성해 가산 혼합 스프라이트/교차 평면으로 사용 (`public/assets/vfx/`)
- 스킬 렉 수정: 섬광탄이 PointLight를 동적으로 추가/제거해 모든 셰이더가 재컴파일되던 것을 상시 풀 조명으로 교체, 로딩 시 효과·스킨드 재질 셰이더 사전 컴파일(`Fx.warmup`, `renderer.compile`)
- 시점 순간이동 버그 수정: Pointer Lock 잠금/포커스 전환 직후 150ms 마우스 입력 무시, 이벤트당 이동량 400px 초과는 스파이크로 폐기·160px로 클램프, 프레임당 회전 상한 60°
- 2차 폴리시: 계단 스텝업 시각 스무딩(카메라·봇 모델), 1인칭 뷰모델 2패스 렌더(벽 뚫림 방지)·그림자 제거·크기 축소·재장전 모션·시선 스웨이, 사망 중 피격 발광 제거, 힐팩 링 양면, 탄환 광선 글로우

M2에서 추가됨
- 다층 내비 그리드 (0.5m 높이필드, 계단 오르기·플랫폼 뛰어내리기, 도달 가능 영역 플러드필)
- 힐팩 6개 (대 250HP/30초 ×2, 소 75HP/15초 ×4) — 플레이어·봇 공용
- 봇 엄폐/피킹 (toCover → hiding → peeking), 저체력 시 힐팩으로 후퇴
- 난이도별 엄폐 사용: EASY 안 함 / NORMAL HP<50%에서 재장전·버스트 휴식 시 / HARD 버스트마다
- 웨이브 5 보스 (레이븐 보스: HP ×3, 1.35배 크기, 조준 정확도↑) + 호위 4, 보스 HP 바, 보스 처치 +500

M1에서 구현됨
- 스카이독 맵 그레이박스 (80×60m, 중앙 플랫폼 + 계단, 컨테이너/크레이트 엄폐물)
- 1인칭 캡슐 컨트롤러 (스텝업, 점프, 공중 제어), 뷰모델/반동/헤드밥
- 펄스 라이플: 탄퍼짐, 거리 감쇠, 헤드샷 ×2, 재장전, 트레이서/스파크/머즐 플래시
- 봇 AI: FSM(순찰→추적→교전→후퇴), 시야/LOS/소리 지각, 반응시간·조준오차·추적속도 모델, 버스트 사격, 스트레이프, 그리드 A* 내비
- 난이도 3단계 (EASY / NORMAL / HARD)
- 웨이브 5개 (봇 3→7), 라이프 3, 리스폰 3초 + 무적 1.5초, 결과 화면/통계
- HUD: HP, 탄약, 동적 크로스헤어, 히트마커, 피해 숫자, 피격 방향, 킬 피드, 궁 게이지(표시만)
- WebAudio 합성 임시 효과음

남은 제한 (M4 이후)
- 플레이어블 영웅은 레이븐 1명, 보스는 레이븐 변형 — M4에서 불워크/노바/호크 추가
- 맵 모듈(컨테이너·크레인)은 아직 프리미티브 + 텍스처, 1인칭 팔 없음
- 사운드는 WebAudio 합성 임시 음

## 플레이테스트 (오토파일럿)

`src/dev/Autopilot.ts`는 사람처럼 플레이어를 조작한다(반응시간·조준 오차·추적 속도·버스트·스트레이프·스킬 판단). 프로필: casual / average / good.
인게임 F8로 켜거나, 개발자 콘솔에서 시뮬레이션을 빠르게 돌려 밸런스 데이터를 뽑는다:

```js
// 콘솔: 난이도 버튼 클릭 → 시작 → 오토파일럿 → 60Hz 스텝을 직접 호출
document.querySelector('#difficulty [data-d="normal"]').click(); document.getElementById('btn-start').click();
game.setAutopilot('average'); for (let i = 0; i < 60 * 300; i++) game.step(1 / 60);
console.table(game.waveLog); console.log(game.player.stats);
```

2026-11-09 측정 (각 2회): EASY/casual 승리(사망 2) · NORMAL/average 웨이브 3~5 도달 · HARD/good 웨이브 2 전멸.
봇은 난이도별 공격 토큰(동시 사격 봇 수)과 피해 배율로 압박을 조절한다 (`src/data/difficulty.ts`).

## 에셋 파이프라인 (힉스필드)

| 에셋 | 도구 | 결과 |
|---|---|---|
| 레이븐 컨셉 (A-pose, 2안) | `generate_image` gpt_image_2_6 | `public/assets/concept/raven_concept.png` |
| 레이븐 3D + 리깅 | `generate_3d` image_to_3d (texture, PBR, rig, a-pose, 12k) | `public/assets/models/raven.glb` |
| 레이븐 애니메이션 | `generate_3d` 3d_rigging + animation_action_id | `raven_idle/run/shoot/death.glb` |
| 펄스 라이플 | `generate_3d` tripo_h3_1_image_to_3d (6k faces) | `public/assets/models/pulse_rifle.glb` |
| 스카이 파노라마 (21:9) | `generate_image` | `public/assets/textures/sky_panorama.jpg` |
| 바닥 / 컨테이너 타일 | `generate_image` (seamless) | `floor_plates.jpg`, `container_panel.jpg` |
| VFX 스프라이트 4종 | `generate_image_batch` (검은 배경 → 가산 혼합) | `public/assets/vfx/*.png` |
| 효과음 20종 | `generate_audio_batch` mirelo_text_to_audio (0.25 크레딧/클립) | `public/assets/sfx/*.mp3` + `manifest.json` |

GLB 구조 확인: `node tools/glb-info.mjs public/assets/models/*.glb`
GLB 최적화: `node tools/optimize-glb.mjs` (원본은 `tools/.backup/`에 보관, 새 에셋을 받은 뒤 한 번 실행)

## 배포 (GitHub Pages)

```bash
npm run deploy:pages
```

처음 실행 시 공개 저장소 `skyfall-arena`를 만들고 소스를 푸시한 뒤, `dist/`를 `gh-pages` 브랜치로 올리고 Pages 소스를 설정한다. 이후 실행은 빌드·재배포만 한다. Vite `base: './'`라 하위 경로(`/skyfall-arena/`)에서도 에셋 경로가 맞는다.

## 폴더

```
src/core      게임 루프, 입력, 사운드, 컨텍스트
src/world     그레이박스 맵, 웨이브 매니저, 힐팩
src/ai        다층 내비 그리드 (높이필드 A*)
src/entities  Player, Bot, CharacterController
src/combat    Weapon, Hitscan
src/render    Fx (트레이서/스파크/디졸브)
src/ui        Hud (DOM 오버레이)
src/data      heroes / waves / difficulty 수치
```

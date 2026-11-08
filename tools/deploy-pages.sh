#!/usr/bin/env bash
# GitHub Pages 배포: 빌드 → dist를 gh-pages 브랜치로 강제 푸시 → Pages 소스 설정
# 사용: bash tools/deploy-pages.sh [repo-name]   (처음 한 번은 공개 저장소 생성이 필요)
set -euo pipefail
REPO="${1:-skyfall-arena}"
OWNER="$(gh api user -q .login)"
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO" --public --source=. --remote=origin --push \
    --description "웹 브라우저용 하이퍼 FPS 프로토타입 (Three.js) — 싱글 플레이, AI 봇 웨이브 섬멸전"
fi
npm run build
URL="$(git remote get-url origin)"
rm -rf dist/.git
( cd dist && git init -q -b gh-pages && git add -A && git -c user.name="$OWNER" -c user.email="$OWNER@users.noreply.github.com" commit -q -m "deploy $(date +%F_%H%M)" && git push -f "$URL" gh-pages:gh-pages )
# Pages 소스: gh-pages 브랜치 루트 (이미 설정돼 있으면 PUT으로 갱신)
gh api -X POST "repos/$OWNER/$REPO/pages" -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null 2>&1 \
  || gh api -X PUT "repos/$OWNER/$REPO/pages" -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null
echo "배포 URL: https://$OWNER.github.io/$REPO/  (반영까지 1~2분)"

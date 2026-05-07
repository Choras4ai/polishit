#!/bin/bash
# 润石 PoliShit 官网手动发布脚本
# 用法: ./scripts/deploy-pages.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$ROOT_DIR/docs"
BUILD_SCRIPT="$ROOT_DIR/scripts/build-site-dist.sh"
SITE_DIST_DIR="$ROOT_DIR/.site-dist"
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1 && [ -x "/Users/choras/local/node/bin/node" ]; then
  NODE_BIN="/Users/choras/local/node/bin/node"
fi
REPO="$("$NODE_BIN" -e "const url=require('$ROOT_DIR/package.json').repository.url||''; const m=url.match(/github\\.com[:/](.+?)\\.git$/); if(!m){process.exit(1)}; process.stdout.write(m[1])")"
VERSION="$("$NODE_BIN" -e "process.stdout.write(require('$ROOT_DIR/package.json').version)")"
TARGET_BRANCH="${RUNSHI_PAGES_BRANCH:-gh-pages}"

echo "=== 润石 PoliShit 官网发布 ==="
echo "目标仓库: $REPO"
echo "目标分支: $TARGET_BRANCH"
echo ""

"$BUILD_SCRIPT" "$SITE_DIST_DIR" >/dev/null

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

git clone "git@github.com:${REPO}.git" "$TMPDIR/site"
cd "$TMPDIR/site"

if git ls-remote --exit-code --heads origin "$TARGET_BRANCH" >/dev/null 2>&1; then
  git checkout "$TARGET_BRANCH"
else
  git checkout --orphan "$TARGET_BRANCH"
fi

find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$SITE_DIST_DIR"/. .

find . -name .DS_Store -delete
find . -name __pycache__ -type d -prune -exec rm -rf {} +

git add -A
git commit -m "deploy: 官网静态站点"
echo "→ 推送到 origin/${TARGET_BRANCH} ..."
git push origin "$TARGET_BRANCH"

echo ""
echo "✅ 发布完成"
echo "站点地址: https://www.runshi.top/"
echo "安装包请发布到 GitHub Releases: scripts/publish-release-assets.sh"

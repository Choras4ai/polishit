#!/bin/bash
# Upload current desktop installers to the matching GitHub Release.
# Usage: scripts/publish-release-assets.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1 && [ -x "/Users/choras/local/node/bin/node" ]; then
  NODE_BIN="/Users/choras/local/node/bin/node"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "未找到 GitHub CLI: gh"
  echo "请先安装 gh 并执行 gh auth login。"
  exit 1
fi

REPO="$("$NODE_BIN" -e "const url=require('$ROOT_DIR/package.json').repository.url||''; const m=url.match(/github\\.com[:/](.+?)\\.git$/); if(!m){process.exit(1)}; process.stdout.write(m[1])")"
VERSION="$("$NODE_BIN" -e "process.stdout.write(require('$ROOT_DIR/package.json').version)")"
TAG="${RUNSHI_RELEASE_TAG:-v${VERSION}}"
MAC_SRC="$ROOT_DIR/dist/润石 PoliShit-${VERSION}-arm64.dmg"
WIN_SRC="$ROOT_DIR/dist/润石 PoliShit Setup ${VERSION}.exe"
MAC_NAME="runshi-polis-${VERSION}-arm64.dmg"
WIN_NAME="runshi-polis-setup-${VERSION}.exe"

for file in "$MAC_SRC" "$WIN_SRC"; do
  if [ ! -f "$file" ]; then
    echo "未找到安装包: $file"
    echo "请先运行 npm run build:mac 和 npm run build:win。"
    exit 1
  fi
done

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" \
    --repo "$REPO" \
    --title "润石 PoliShit ${TAG}" \
    --notes "润石 PoliShit ${TAG} 发布。"
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cp "$MAC_SRC" "$TMPDIR/$MAC_NAME"
cp "$WIN_SRC" "$TMPDIR/$WIN_NAME"

gh release upload "$TAG" \
  "$TMPDIR/$MAC_NAME" \
  "$TMPDIR/$WIN_NAME" \
  --repo "$REPO" \
  --clobber

echo "Release 资产已上传:"
echo "https://github.com/${REPO}/releases/tag/${TAG}"

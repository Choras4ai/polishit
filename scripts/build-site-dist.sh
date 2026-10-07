#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$ROOT_DIR/docs"
SITE_DIST_DIR="${1:-$ROOT_DIR/.site-dist}"

SITE_DIST_DIR="$(node -e 'console.log(require("path").resolve(process.argv[1]))' "$SITE_DIST_DIR")"
if [ "$(dirname "$SITE_DIST_DIR")" != "$ROOT_DIR" ]; then
  echo 'Site output must be a direct child of the project.' >&2
  exit 1
fi
case "$SITE_DIST_DIR/" in
  "$ROOT_DIR/.site-dist/"|"$ROOT_DIR/.site-dist-"*) ;;
  *) echo 'Site output must be .site-dist or .site-dist-* inside the project.' >&2; exit 1 ;;
esac
if [ -L "$SITE_DIST_DIR" ]; then
  echo 'Site output cannot be a symbolic link.' >&2
  exit 1
fi
node "$ROOT_DIR/scripts/build-addins.js"
rm -rf -- "$SITE_DIST_DIR"
mkdir -p "$SITE_DIST_DIR"

rsync -a \
  --delete \
  --exclude 'downloads' \
  --exclude '.DS_Store' \
  "$DOCS_DIR/" "$SITE_DIST_DIR/"

mkdir -p "$SITE_DIST_DIR/addins"
rsync -a "$ROOT_DIR/integrations/dist/" "$SITE_DIST_DIR/addins/"
touch "$SITE_DIST_DIR/.nojekyll"

echo "$SITE_DIST_DIR"

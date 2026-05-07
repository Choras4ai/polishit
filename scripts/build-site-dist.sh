#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="$ROOT_DIR/docs"
SITE_DIST_DIR="${1:-$ROOT_DIR/.site-dist}"

rm -rf "$SITE_DIST_DIR"
mkdir -p "$SITE_DIST_DIR"

rsync -a \
  --delete \
  --exclude 'downloads' \
  --exclude '.DS_Store' \
  "$DOCS_DIR/" "$SITE_DIST_DIR/"

touch "$SITE_DIST_DIR/.nojekyll"

echo "$SITE_DIST_DIR"
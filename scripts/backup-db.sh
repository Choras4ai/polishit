#!/bin/bash
# 润石数据库每日备份脚本
# 用法: crontab -e 添加 → 0 3 * * * /path/to/scripts/backup-db.sh
# 或配合 OSS 工具上传: ... && ossutil cp "$BACKUP_FILE" oss://your-bucket/backups/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_PATH="${RUNSHI_DB_PATH:-$PROJECT_DIR/data/commercial.sqlite3}"
BACKUP_DIR="${RUNSHI_BACKUP_DIR:-$PROJECT_DIR/data/backups}"
KEEP_DAYS="${RUNSHI_BACKUP_KEEP_DAYS:-30}"

if [ ! -f "$DB_PATH" ]; then
  echo "[backup] Database not found: $DB_PATH"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/commercial_${TIMESTAMP}.sqlite3"

# Use SQLite's online backup API (safe even while server is running with WAL mode)
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Compress
gzip "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"

echo "[backup] Created: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# Clean up old backups
find "$BACKUP_DIR" -name 'commercial_*.sqlite3.gz' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true

echo "[backup] Cleanup: removed backups older than ${KEEP_DAYS} days"

# Optional: upload to OSS (uncomment and configure)
# if command -v ossutil &> /dev/null; then
#   ossutil cp "$BACKUP_FILE" "oss://${RUNSHI_OSS_BUCKET:-runshi-backups}/db-backups/" --force
#   echo "[backup] Uploaded to OSS"
# fi

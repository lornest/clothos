#!/bin/sh
set -e

# ── Seed agent bootstrap files ──────────────────────────────
# Copy default bootstrap files (SOUL.md, TOOLS.md, etc.) into each
# agent's data directory on first run or when the image changes.
# Existing files are NOT overwritten — only missing files are seeded.
SEED_DIR="/app/data"
AGENTS_DIR="${CLOTHOS_BASE:-/data}/agents"

if [ -d "$SEED_DIR" ]; then
  for agent_dir in "$SEED_DIR"/*/; do
    [ -d "$agent_dir" ] || continue
    agent_id=$(basename "$agent_dir")
    target_dir="$AGENTS_DIR/$agent_id"
    mkdir -p "$target_dir"

    for file in "$agent_dir"*; do
      [ -f "$file" ] || continue
      filename=$(basename "$file")
      target_file="$target_dir/$filename"
      if [ ! -f "$target_file" ]; then
        cp "$file" "$target_file"
        echo "[SEED] Copied $filename → $target_dir/"
      fi
    done
  done
fi

# ── Launch the application ───────────────────────────────────
exec node packages/app/dist/main.js "$@"

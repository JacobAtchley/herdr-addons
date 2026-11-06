#!/usr/bin/env bash
# Installs these mods into herdr-app. Never overwrites anything you already have.
#   ./install.sh              copy every mod, layout and theme in; add settings and keys
#   ./install.sh ado-prs …    only the named mods
#   ./install.sh --update     also refresh mods you already have from this repo (after a git pull)
#   ./install.sh --pull       copy your installed mods back into this repo (to commit your edits)
#
# Mods are copied, not symlinked: herdr doesn't load a mod's icons through a symlink.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HERDR_HOME:-$HOME/.config/herdr-app}"
MODE=install
MODS=()
for a in "$@"; do
  case "$a" in
    --update) MODE=update ;;
    --pull) MODE=pull ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) MODS+=("$a") ;;
  esac
done
[ ${#MODS[@]} -eq 0 ] && for d in "$REPO"/mods/*/; do MODS+=("$(basename "$d")"); done

[ -d "$HOME_DIR" ] || { echo "No herdr-app folder at $HOME_DIR (set HERDR_HOME)"; exit 1; }
mkdir -p "$HOME_DIR/mods" "$HOME_DIR/layouts" "$HOME_DIR/themes"

# Files herdr writes per machine; never synced either way.
SKIP=(--exclude gpui-kit.d.ts --exclude __pycache__ --exclude .DS_Store)

if [ "$MODE" = pull ]; then
  for m in "${MODS[@]}"; do
    src="$HOME_DIR/mods/$m"
    [ -d "$src" ] || { echo "skip $m: not installed"; continue; }
    rsync -a --delete "${SKIP[@]}" --exclude jsconfig.json "$src/" "$REPO/mods/$m/"
    echo "pull $m"
  done
  git -C "$REPO" status --short
  exit 0
fi

for m in "${MODS[@]}"; do
  src="$REPO/mods/$m"; dst="$HOME_DIR/mods/$m"
  [ -d "$src" ] || { echo "skip $m: no such mod"; continue; }
  if [ -L "$dst" ]; then
    echo "skip $m: $dst is a symlink (icons won't load); delete it and run again"
    continue
  fi
  if [ -e "$dst" ]; then
    if [ "$MODE" = update ]; then
      rsync -a "${SKIP[@]}" --exclude jsconfig.json "$src/" "$dst/"
      echo "upd  $m"
    else
      echo "skip $m: already installed (--update refreshes it)"
    fi
    continue
  fi
  # mod.json must land before main.js, or herdr may dock a half-copied mod.
  mkdir -p "$dst" && cp "$src/mod.json" "$dst/"
  rsync -a "${SKIP[@]}" "$src/" "$dst/"
  echo "add  $m"
done

for f in "$REPO"/layouts/* "$REPO"/themes/*; do
  dst="$HOME_DIR/$(basename "$(dirname "$f")")/$(basename "$f")"
  if [ -e "$dst" ]; then echo "skip $(basename "$f"): exists"; else cp "$f" "$dst"; echo "add  $(basename "$f")"; fi
done

if [ ! -e "$HOME_DIR/addons.json" ]; then
  cp "$REPO/addons.example.json" "$HOME_DIR/addons.json"
  echo "add  addons.json (edit it: see README → Settings)"
fi

# Keys: add the ones you don't use yet; report the ones you already bound.
python3 - "$REPO/keys.json" "$HOME_DIR/keys.json" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
want = json.load(open(src))
have = json.load(open(dst)) if os.path.exists(dst) else {}
added = 0
for section, keys in want.items():
    cur = have.setdefault(section, {})
    for k, v in keys.items():
        if k not in cur:
            cur[k] = v; added += 1
        elif cur[k] != v:
            print(f"keep {k}: already {cur[k]!r} (wanted {v!r})")
if added:
    tmp = dst + ".tmp"
    with open(tmp, "w") as f:
        json.dump(have, f, indent=2); f.write("\n")
    os.replace(tmp, dst)
print(f"keys: {added} added")
PY

command -v herdr-app >/dev/null && for m in "${MODS[@]}"; do herdr-app check "$m" 2>&1 | tail -1; done || true

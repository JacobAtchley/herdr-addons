#!/usr/bin/env bash
# Installs these mods into herdr-app. Never overwrites anything you already have.
#   ./install.sh            link each mod (edits here show up live in herdr)
#   ./install.sh --copy     copy instead of link
#   ./install.sh ado-prs …  only the named mods
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HERDR_HOME:-$HOME/.config/herdr-app}"
MODE=link
MODS=()
for a in "$@"; do
  case "$a" in
    --copy) MODE=copy ;;
    -h|--help) sed -n 2,5p "$0"; exit 0 ;;
    *) MODS+=("$a") ;;
  esac
done
[ ${#MODS[@]} -eq 0 ] && for d in "$REPO"/mods/*/; do MODS+=("$(basename "$d")"); done

[ -d "$HOME_DIR" ] || { echo "No herdr-app folder at $HOME_DIR (set HERDR_HOME)"; exit 1; }
mkdir -p "$HOME_DIR/mods" "$HOME_DIR/layouts" "$HOME_DIR/themes"

for m in "${MODS[@]}"; do
  src="$REPO/mods/$m"; dst="$HOME_DIR/mods/$m"
  [ -d "$src" ] || { echo "skip $m: no such mod"; continue; }
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    [ "$(readlink "$dst" || true)" = "$src" ] && echo "ok   $m (already linked)" || echo "skip $m: $dst exists"
    continue
  fi
  # mod.json must land before main.js, or herdr may dock a half-copied mod.
  if [ "$MODE" = copy ]; then
    mkdir -p "$dst" && cp "$src/mod.json" "$dst/" && cp -R "$src/." "$dst/"
  else
    ln -s "$src" "$dst"
  fi
  echo "add  $m ($MODE)"
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

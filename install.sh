#!/usr/bin/env bash
# Installs these addons into herdr-app. Never overwrites anything you already have.
#   ./install.sh                  every addon: mods, layouts, themes, settings, keys
#   ./install.sh azure-devops …   only the named addons (folders here) or mods
#   ./install.sh --update         also refresh mods you already have (after a git pull)
#   ./install.sh --pull           copy your installed mods back into this repo (to commit your edits)
#
# Mods are copied, not symlinked: herdr doesn't load a mod's icons through a symlink.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HERDR_HOME:-$HOME/.config/herdr-app}"
MODE=install
ARGS=()
for a in "$@"; do
  case "$a" in
    --update) MODE=update ;;
    --pull) MODE=pull ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done

# Addons are the top-level folders holding a mods/ or layouts/ folder.
ADDONS=()
for d in "$REPO"/*/; do
  d="${d%/}"
  [ -d "$d/mods" ] || [ -d "$d/layouts" ] && ADDONS+=("$(basename "$d")")
done

# Pick addons: by addon name, or the addon holding a named mod.
PICK=()
if [ ${#ARGS[@]} -eq 0 ]; then
  PICK=("${ADDONS[@]}")
else
  for a in "${ARGS[@]}"; do
    if [ -d "$REPO/$a/mods" ] || [ -d "$REPO/$a/layouts" ]; then PICK+=("$a"); continue; fi
    hit=$(cd "$REPO" && ls -d */mods/"$a" 2>/dev/null | head -1 || true)
    [ -n "$hit" ] && PICK+=("${hit%%/*}") || echo "skip $a: no such addon or mod"
  done
fi
[ ${#PICK[@]} -eq 0 ] && exit 0

[ -d "$HOME_DIR" ] || { echo "No herdr-app folder at $HOME_DIR (set HERDR_HOME)"; exit 1; }
mkdir -p "$HOME_DIR/mods" "$HOME_DIR/layouts" "$HOME_DIR/themes"

# Files herdr writes per machine; never synced either way.
SKIP=(--exclude gpui-kit.d.ts --exclude __pycache__ --exclude .DS_Store)
MODS=()

for addon in "${PICK[@]}"; do
  for src in "$REPO/$addon"/mods/*/; do
    [ -d "$src" ] || continue
    src="${src%/}"; m="$(basename "$src")"; dst="$HOME_DIR/mods/$m"
    MODS+=("$m")
    if [ "$MODE" = pull ]; then
      [ -d "$dst" ] || { echo "skip $m: not installed"; continue; }
      rsync -a --checksum --delete "${SKIP[@]}" --exclude jsconfig.json "$dst/" "$src/"
      echo "pull $m"
      continue
    fi
    if [ -L "$dst" ]; then
      echo "skip $m: $dst is a symlink (icons won't load); delete it and run again"
      continue
    fi
    if [ -e "$dst" ]; then
      if [ "$MODE" = update ]; then
        rsync -a --checksum "${SKIP[@]}" --exclude jsconfig.json "$src/" "$dst/"
        echo "upd  $m"
      else
        echo "skip $m: already installed (--update refreshes it)"
      fi
      continue
    fi
    # mod.json must land before main.js, or herdr may dock a half-copied mod.
    mkdir -p "$dst" && cp "$src/mod.json" "$dst/"
    rsync -a --checksum "${SKIP[@]}" "$src/" "$dst/"
    echo "add  $m"
  done
done

if [ "$MODE" = pull ]; then
  git -C "$REPO" status --short
  exit 0
fi

copy_new() { # $1 = file, $2 = folder under the herdr home
  local dst="$HOME_DIR/$2/$(basename "$1")"
  if [ -e "$dst" ]; then echo "skip $(basename "$1"): exists"; else cp "$1" "$dst"; echo "add  $(basename "$1")"; fi
}
for addon in "${PICK[@]}"; do
  for f in "$REPO/$addon"/layouts/*; do [ -f "$f" ] && copy_new "$f" layouts; done
done
[ ${#ARGS[@]} -eq 0 ] && for f in "$REPO"/themes/*.json; do copy_new "$f" themes; done

if [ ! -e "$HOME_DIR/addons.json" ]; then
  cp "$REPO/addons.example.json" "$HOME_DIR/addons.json"
  echo "add  addons.json (edit it: see README → Settings)"
fi

# Keys: add the ones you don't use yet; report the ones you already bound.
KEYS=()
for addon in "${PICK[@]}"; do [ -f "$REPO/$addon/keys.json" ] && KEYS+=("$REPO/$addon/keys.json"); done
if [ ${#KEYS[@]} -gt 0 ]; then
  python3 - "$HOME_DIR/keys.json" "${KEYS[@]}" <<'PY'
import json, os, sys
dst, srcs = sys.argv[1], sys.argv[2:]
have = json.load(open(dst)) if os.path.exists(dst) else {}
added = 0
for src in srcs:
    for section, keys in json.load(open(src)).items():
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
fi

if command -v herdr-app >/dev/null; then
  for m in "${MODS[@]}"; do herdr-app check "$HOME_DIR/mods/$m" 2>&1 | tail -1; done
fi

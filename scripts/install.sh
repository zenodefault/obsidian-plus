#!/usr/bin/env bash
# Install the Sovereign Second Brain plugin into local Obsidian vaults.
#
# One command, no manual copying: builds the core + plugin, finds every vault
# registered with the installed Obsidian app (via its global obsidian.json),
# copies the plugin bundle AND the sovereign-core binary into each vault, and
# enables the plugin. Re-running is safe (idempotent).
#
# Usage:
#   ./scripts/install.sh               # build + install into all vaults
#   ./scripts/install.sh --no-build    # install using the current build output
#   ./scripts/install.sh --vault PATH  # install into specific vault(s) only
#   ./scripts/install.sh --list        # show detected vaults and exit
#   ./scripts/install.sh --uninstall   # remove the plugin from all vaults
#
# Notes:
#   - Obsidian picks up new files after a reload (Ctrl/Cmd+R) or restart.
#   - If restricted mode (community plugins off) is active, Obsidian hides
#     every community plugin; disable it once in Settings → Community plugins.
set -euo pipefail
cd "$(dirname "$0")/.."

PLUGIN_ID="sovereign-second-brain"
PLUGIN_DIR="plugin"
CORE_BIN="core/target/release/sovereign-core"

BUILD=1
UNINSTALL=0
LIST_ONLY=0
CONFIG="${SOVEREIGN_OBSIDIAN_CONFIG:-}"
REQUESTED_VAULTS=()

usage() { sed -n '2,16p' "$0"; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --list) LIST_ONLY=1 ;;
    --vault) shift; REQUESTED_VAULTS+=("$1") ;;
    --config) shift; CONFIG="$1" ;;
    -h|--help) usage ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || {
  echo "error: node is required (Obsidian plugin tooling prerequisite)" >&2
  exit 1
}

# ---- build -----------------------------------------------------------------

if [ "$BUILD" = 1 ] && [ "$UNINSTALL" = 0 ]; then
  ./scripts/build.sh
fi

if [ "$UNINSTALL" = 0 ]; then
  for f in "$PLUGIN_DIR/main.js" "$PLUGIN_DIR/manifest.json" "$PLUGIN_DIR/styles.css" "$CORE_BIN"; do
    [ -f "$f" ] || {
      echo "error: $f missing — run ./scripts/build.sh first (or drop --no-build)" >&2
      exit 1
    }
  done
fi

# ---- locate the Obsidian app config ----------------------------------------

if [ -z "$CONFIG" ]; then
  for candidate in \
    "${APPDATA:-}/obsidian/obsidian.json" \
    "$HOME/Library/Application Support/obsidian/obsidian.json" \
    "$HOME/.config/obsidian/obsidian.json"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      CONFIG="$candidate"
      break
    fi
  done
fi

if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
  echo "error: Obsidian's obsidian.json not found." >&2
  echo "Looked in \$APPDATA/obsidian, ~/Library/Application Support/obsidian and ~/.config/obsidian." >&2
  echo "Pass it explicitly: ./scripts/install.sh --config /path/to/obsidian.json" >&2
  exit 1
fi

# ---- collect vault paths -----------------------------------------------------

# Windows-style paths (C:\...) are normalized via cygpath when available so
# the rest of the script can treat them as POSIX paths.
norm() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1" 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

VAULT_LIST="$(node -e '
  const fs = require("fs");
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  } catch (e) {
    console.error("error: could not parse " + process.argv[1] + ": " + e.message);
    process.exit(1);
  }
  const vaults = cfg.vaults ?? {};
  for (const v of Object.values(vaults)) {
    if (v && typeof v.path === "string" && v.path.trim()) console.log(v.path);
  }
' "$CONFIG")"

if [ -z "$VAULT_LIST" ]; then
  echo "error: no vaults registered in $CONFIG" >&2
  exit 1
fi

if [ "$LIST_ONLY" = 1 ]; then
  echo "Vaults registered with Obsidian ($CONFIG):"
  echo "$VAULT_LIST" | while IFS= read -r v; do echo "  - $(norm "$v")"; done
  exit 0
fi

# Targets: explicit --vault paths, or every registered vault.
TARGETS=()
if [ "${#REQUESTED_VAULTS[@]}" -gt 0 ]; then
  for v in "${REQUESTED_VAULTS[@]}"; do TARGETS+=("$(norm "$v")"); done
else
  while IFS= read -r v; do TARGETS+=("$(norm "$v")"); done <<< "$VAULT_LIST"
fi

# ---- install / uninstall per vault -------------------------------------------

had_community_file=0
installed=0
removed=0

# Enable (or disable) the plugin id in a vault's community-plugins.json.
toggle_plugin() {
  local vault="$1" mode="$2"
  local obsidian_dir="$vault/.obsidian"
  local plugins_file="$obsidian_dir/community-plugins.json"
  mkdir -p "$obsidian_dir"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const id = process.argv[2];
    const mode = process.argv[3];
    let list = [];
    if (fs.existsSync(file)) {
      try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch { list = []; }
    }
    if (!Array.isArray(list)) list = [];
    if (mode === "on" && !list.includes(id)) list.push(id);
    if (mode === "off") list = list.filter((x) => x !== id);
    fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
  ' "$plugins_file" "$PLUGIN_ID" "$mode"
}

if [ "$UNINSTALL" = 1 ]; then
  for vault in "${TARGETS[@]}"; do
    [ -d "$vault" ] || { echo "skip (not a directory): $vault"; continue; }
    target="$vault/.obsidian/plugins/$PLUGIN_ID"
    if [ -d "$target" ]; then
      rm -rf "$target"
      removed=$((removed + 1))
      echo "removed: $target"
    fi
    toggle_plugin "$vault" "off"
  done
  echo
  echo "Uninstalled from $removed vault(s). Reload Obsidian to finish."
  exit 0
fi

for vault in "${TARGETS[@]}"; do
  if [ ! -d "$vault" ]; then
    echo "skip (not a directory): $vault"
    continue
  fi
  if [ ! -d "$vault/.obsidian" ]; then
    echo "skip (no .obsidian dir — is this really a vault?): $vault"
    continue
  fi

  target="$vault/.obsidian/plugins/$PLUGIN_ID"
  mkdir -p "$target/bin"

  cp "$PLUGIN_DIR/manifest.json" "$target/manifest.json"
  cp "$PLUGIN_DIR/main.js" "$target/main.js"
  cp "$PLUGIN_DIR/styles.css" "$target/styles.css"
  # The core binary rides along so the plugin's auto-detect finds it no
  # matter where the vault lives (services/daemon/spawn.ts candidate 3).
  cp "$CORE_BIN" "$target/bin/sovereign-core"
  chmod +x "$target/bin/sovereign-core"

  if [ -f "$vault/.obsidian/community-plugins.json" ]; then
    had_community_file=$((had_community_file + 1))
  fi
  toggle_plugin "$vault" "on"

  installed=$((installed + 1))
  echo "installed + enabled: $target"
done

if [ "$installed" = 0 ]; then
  echo "error: nothing installed (no valid vault targets)" >&2
  exit 1
fi

echo
echo "Done. Installed into $installed vault(s)."
echo "  - Reload Obsidian (Ctrl/Cmd+R) or restart it to load the plugin."
if [ "$had_community_file" = 0 ]; then
  echo "  - If the plugin does not appear, Settings → Community plugins →"
  echo "    turn off restricted mode once (Obsidian hides all community"
  echo "    plugins until then; this is the one step that cannot be automated)."
fi
echo "  - The brain overlay: Ctrl/Cmd+Shift+B · graph: fork icon in the left ribbon."

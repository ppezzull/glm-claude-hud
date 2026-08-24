#!/usr/bin/env bash
# One-line installer for glm-claude-hud.
# Installs the wrapper and prints the statusLine block to add to ~/.claude/settings.json.
set -euo pipefail

REPO_URL="https://raw.githubusercontent.com/ppezzull/glm-claude-hud/main/glm-wrapper.ts"
SCRIPTS_DIR="$HOME/.claude/scripts"
SETTINGS="$HOME/.claude/settings.json"

# Resolve bun (absolute path — required for minimal-PATH environments like Warp)
BUN="$(command -v bun 2>/dev/null || true)"
for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -z "$BUN" ] && [ -x "$candidate" ] && BUN="$candidate"
done
if [ -z "$BUN" ]; then
  echo "error: bun not found. Install it first: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

mkdir -p "$SCRIPTS_DIR"
curl -fsSL "$REPO_URL" -o "$SCRIPTS_DIR/glm-wrapper.ts"
chmod +x "$SCRIPTS_DIR/glm-wrapper.ts"

echo "wrapper installed at $SCRIPTS_DIR/glm-wrapper.ts"
echo
echo "Verify it renders:"
echo "  echo '{\"model\":{\"display_name\":\"test\"}}' | $BUN $SCRIPTS_DIR/glm-wrapper.ts"
echo
echo "Then merge this into $SETTINGS (and restart your Claude Code sessions):"
cat <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "$BUN \"\\\$HOME/.claude/scripts/glm-wrapper.ts\""
  }
}
EOF

# C/F preserve terminal state; E/J isolate MCP commands. Python owns the event loop.
umask 077
export LC_ALL=C
set +H
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" 2>/dev/null; fi
set +e +u +H
set +o pipefail
set +m
umask 077
[ -n "$SRB_DIR" ] && [ -d "$SRB_DIR" ] || exit 1
if ! /usr/bin/python3 -c 'import sys; assert sys.version_info >= (3,9)' 2>/dev/null; then
  printf '%s\n' 'ssh-remote-bridge requires /usr/bin/python3 >= 3.9' >&2
  exit 1
fi
export SRB_STATE="$SRB_DIR/state"
while read -r _ _ fn; do export -f "$fn" 2>/dev/null; done < <(declare -F)
compgen -e > "$SRB_DIR/base-vars"
cat > "$SRB_DIR/exec-loop.py" <<'SRB_PYTHON'
__SRB_CONTROLLER__
SRB_PYTHON
exec /usr/bin/python3 -u "$SRB_DIR/exec-loop.py"

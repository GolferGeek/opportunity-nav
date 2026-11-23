#!/usr/bin/env bash
# Build the desktop app and install it over the copy in ~/.local/share, without
# crashing the one that's running: ask it to quit (`--quit`), wait until every
# one of its processes is gone, replace the files, then start it again.
#
#   apps/desktop/scripts/install-linux.sh             build, then install
#   apps/desktop/scripts/install-linux.sh --no-build  install the last build
#
# Never `pkill -f` the app: that signals the browser, GPU, zygote and renderer
# processes all at once, and Chromium aborts with SIGTRAP and a core dump.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
dest=${OPNAV_DESKTOP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/opportunity-nav/desktop}
exe="$dest/opportunity-nav"

if [[ ${1:-} != --no-build ]]; then
  (cd "$here" && npm run dist -- --linux dir)
fi
shopt -s nullglob
builds=("$here"/release/linux*-unpacked)
[[ ${#builds[@]} -eq 1 && -x ${builds[0]}/opportunity-nav ]] || { echo "No single build in $here/release (run without --no-build)." >&2; exit 1; }
src=${builds[0]}

# Every process of the installed app, including ones whose binary was already replaced.
app_pids() {
  local pid
  for pid in $(pgrep -x opportunity-nav || true); do
    [[ $(readlink "/proc/$pid/exe" 2>/dev/null) == "$exe"* ]] && echo "$pid"
  done
}
# The browser process: the one without --type= on its command line.
main_pid() {
  local pid
  for pid in $(app_pids); do
    tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | grep -q '^--type=' || { echo "$pid"; return; }
  done
}
wait_gone() { # seconds
  local i
  for ((i = 0; i < $1 * 4; i++)); do
    [[ -z $(app_pids) ]] && return 0
    sleep 0.25
  done
  return 1
}

was_running=false
if pid=$(main_pid) && [[ -n $pid ]]; then
  was_running=true
  if grep -qa -- '--quit' "$dest/resources/app.asar" 2>/dev/null; then
    echo "Asking Opportunity Nav to quit…"
    "$exe" --quit >/dev/null 2>&1 || true
  else
    # Builds from before --quit: SIGTERM the browser process alone; it shuts its children down itself.
    echo "Stopping Opportunity Nav (pid $pid)…"
    kill -TERM "$pid"
  fi
  if ! wait_gone 20; then
    echo "Opportunity Nav is still running (pids: $(app_pids | xargs)). Quit it and run this again with --no-build." >&2
    exit 1
  fi
fi

mkdir -p "$dest"
rsync -a --delete "$src/" "$dest/"
echo "Installed $src to $dest"

if $was_running; then
  setsid -f "$exe" --ozone-platform-hint=auto >/dev/null 2>&1 </dev/null
  echo "Started it again."
fi

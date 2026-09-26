#!/bin/sh
# The desktop session, as this image means it: the components, started in order.
#
# xfce4-session is deliberately not used. Its job is saving and restoring session
# state, and on a streamed workspace that state is a liability: with no saved
# session it started *no clients at all* - no window manager, no panel, no desktop
# - while its unit reported "active/running", the stream served the empty
# framebuffer, and the API reported the workspace as up. Every one of those signals
# was true and the user had nothing to click.
#
# Naming the components removes the question. Three details this script learned the
# hard way:
#
#   * a component needs a moment to appear, and a check that runs too early turns
#     into a restart loop (systemd restarted this session every six seconds because
#     the first check beat xfwm4's exec);
#   * the process to check is the one this script started, not a name in the
#     process table - NixOS wraps XFCE's binaries, so the window manager identifies
#     as `.xfwm4-wrapped` and `pgrep -x xfwm4` matches nothing however healthy the
#     desktop is. Watching it fail to appear looked exactly like a desktop that
#     would not start;
#   * a component that fails says why into its log, and that log is worth keeping
#     until something reads it.
set -eu

log_dir="${XDG_RUNTIME_DIR:-/tmp}"

# Start a component, keeping its output: the failure this script cannot diagnose
# itself is the reason it exists.
start() {
  "$@" >"$log_dir/${1##*/}.log" 2>&1 &
  child=$!
}

alive() {
  kill -0 "$1" 2>/dev/null
}

# Up means still running once it has had the chance to fail. xfwm4 exits
# immediately (status 0) when it cannot initialise Xfconf, so "started" and
# "running" are not the same claim.
settled() {
  pid="$1"
  seconds="${2:-5}"
  i=0
  while [ "$i" -lt "$seconds" ]; do
    if ! alive "$pid"; then
      return 1
    fi
    i=$((i + 1))
    sleep 1
  done
  return 0
}

fail() {
  echo "mytops-session: the $1 did not stay up" >&2
  if [ -r "$log_dir/$1.log" ]; then
    cat "$log_dir/$1.log" >&2
  fi
  exit 1
}

# Session settings daemon first: the panel and the desktop read their settings
# from it, and starting them first gives them nothing to read.
start xfsettingsd --sm-client-disable
settings=$!
settled "$settings" 5 || fail xfsettingsd

# --replace so a restart of the unit cannot leave two window managers arguing over
# the screen; --sm-client-disable because there is no session manager to talk to.
start xfwm4 --sm-client-disable --replace
wm=$!
settled "$wm" 10 || fail xfwm4

start xfce4-panel
panel=$!
settled "$panel" 5 || fail xfce4-panel

start xfdesktop
desktop=$!
settled "$desktop" 5 || fail xfdesktop

# The unit's lifetime is the session's: the window manager is the component whose
# absence means there is no desktop, so follow it and let systemd restart us.
while alive "$wm"; do
  sleep 5
done

echo "the window manager exited; ending the session" >&2
exit 1

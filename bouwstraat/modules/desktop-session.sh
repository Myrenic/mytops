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
# Naming the components removes the question. Two details this script learned the
# hard way: a component needs a moment to appear, and a check that runs too early
# turns into a restart loop (systemd dutifully restarted this session every six
# seconds because the first `pgrep` beat `xfwm4`'s exec).
set -eu

start() {
  "$@" >/dev/null 2>&1 &
}

# Wait for a process to appear, then report whether it did. Starting a thing and
# immediately looking for it is how the race above happened.
await() {
  name="$1"
  tries="${2:-30}"
  i=0
  while [ "$i" -lt "$tries" ]; do
    if pgrep -x "$name" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# Session settings daemon first: the panel and the desktop read their settings
# from it, and starting them first gives them nothing to read.
start xfsettingsd --sm-client-disable
await xfsettingsd 20 || echo "mytops-session: xfsettingsd did not start" >&2

# --replace so a restart of the unit cannot leave two window managers arguing over
# the screen; --sm-client-disable because there is no session manager to talk to.
start xfwm4 --sm-client-disable --replace
if ! await xfwm4 30; then
  echo "mytops-session: the window manager did not start" >&2
  exit 1
fi

start xfce4-panel
await xfce4-panel 20 || echo "mytops-session: the panel did not start" >&2

start xfdesktop
await xfdesktop 20 || echo "mytops-session: the desktop did not start" >&2

# The unit's lifetime is the session's: the window manager is the component whose
# absence means there is no desktop, so follow it and let systemd restart us.
while pgrep -x xfwm4 >/dev/null 2>&1; do
  sleep 5
done

echo "the window manager exited; ending the session" >&2
exit 1

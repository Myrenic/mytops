#!/bin/sh
# The desktop session, as this image means it: the components, started in order.
#
# xfce4-session is deliberately not used. Its job is saving and restoring session
# state, and on a streamed workspace that state is a liability: with no saved
# session it started *no clients at all* - no window manager, no panel, no
# desktop - while its unit reported "active/running", the stream served the empty
# framebuffer, and the API reported the workspace as up. Every one of those signals
# was true and the user had nothing to click.
#
# Naming the components removes the question. If the window manager exits, the
# desktop is gone, so this exits and systemd restarts the session.
set -eu

start() {
  "$@" >/dev/null 2>&1 &
}

# Session settings daemon first: the panel and the desktop read their settings
# from it, and starting them first gives them nothing to read.
start xfsettingsd --sm-client-disable
sleep 1

# --replace so a restart of the unit cannot leave two window managers arguing over
# the screen; --sm-client-disable because there is no session manager to talk to.
start xfwm4 --sm-client-disable --replace
sleep 2

start xfce4-panel
sleep 1

start xfdesktop

# The unit's lifetime is the session's: wait for the window manager.
while pgrep -x xfwm4 >/dev/null 2>&1; do
  sleep 5
done

echo "the window manager exited; ending the session" >&2
exit 1

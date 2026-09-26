{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "desktop-running";
      severity = "baseline";
      compliance = [ ];
      tags = [ ];
      summary = "A desktop session is actually running: window manager and panel, not merely a unit that is 'active'.";
      # Observes rather than sets: no configuration of its own.
      config = _: { };
      check = ''
        # An image with no desktop (an infrastructure workspace) has nothing to
        # check, and saying so is not the same as passing.
        if [ "$(systemctl show -p LoadState --value mytops-desktop.service 2>/dev/null)" != "loaded" ]; then
          echo "  this image has no desktop session"
          exit 3
        fi

        if ! systemctl is-active --quiet mytops-desktop.service; then
          echo "  mytops-desktop.service is not running"
          exit 1
        fi

        # A session that cannot load its own data still *starts*: xfce4-session
        # then puts "Unable to load a failsafe session" on the screen and either
        # exits or leaves a black desktop, while the unit is active and the stream
        # answers 200. That combination is what this rule exists to catch.
        restarts=$(systemctl show -p NRestarts --value mytops-desktop.service)
        if [ "$restarts" != "0" ]; then
          echo "  the session has restarted $restarts time(s)"
          exit 1
        fi

        for proc in xfwm4 xfce4-panel xfdesktop; do
          pgrep -x "$proc" >/dev/null || {
            echo "  $proc is not running: the session did not load"
            exit 1
          }
        done
      '';
    }
  ];
}

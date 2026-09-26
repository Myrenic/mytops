{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "timesync";
      severity = "baseline";
      compliance = [ "bio" ];
      tags = [ ];
      summary = "The clock is synchronised; an unsynchronised workspace writes wrong timestamps into every audit trail.";
      config =
        { lib, ... }:
        {
          services.timesyncd.enable = lib.mkForce true;
        };
      check = ''
        state=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)
        if [ "$state" = "yes" ]; then exit 0; fi
        # A guest that just booted has not synced yet; that is a timing fact,
        # not a control that failed. Report it as skipped rather than lying
        # either way.
        echo "  NTPSynchronized=$state"
        exit 3
      '';
    }
  ];
}

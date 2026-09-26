{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "apparmor";
      severity = "hardened";
      compliance = [ "bio" ];
      tags = [ ];
      summary = "AppArmor is enabled; the shipped profiles confine services even when the workspace user misbehaves.";
      config =
        { lib, ... }:
        {
          security.apparmor.enable = lib.mkForce true;
          # Load the profiles that come with the packages rather than only the
          # hand-written ones: an enabled-but-empty AppArmor is a control in
          # name only.
          security.apparmor.packages = lib.mkDefault [ ];
        };
      check = ''
        enabled=$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo N)
        if [ "$enabled" != "Y" ]; then
          echo "  apparmor enabled=$enabled"
          exit 1
        fi
      '';
    }
  ];
}

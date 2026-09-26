{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "usbguard";
      severity = "hardened";
      compliance = [ ];
      # Excluded by default in the shipped host: a workspace that refuses the
      # USB stick someone just plugged in reads as broken to the person holding
      # it (DAWO put usbguard behind exactly this reasoning). It is on at the
      # hardened level, and a host that wants it back off can either lower the
      # level or set the rule to false.
      tags = [ "breaks-usb" ];
      summary = "Unplugged USB devices are refused unless policy allows them.";
      config =
        { lib, ... }:
        {
          services.usbguard = {
            enable = lib.mkForce true;
            implicitPolicyTarget = lib.mkForce "block";
          };
        };
      check = ''
        if systemctl is-active --quiet usbguard; then exit 0; fi
        echo "  usbguard is not running"
        exit 1
      '';
    }
  ];
}

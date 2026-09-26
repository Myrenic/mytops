{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "sysrq-off";
      severity = "strict";
      compliance = [ ];
      # Magic SysRq is how you rescue a hung machine from a keyboard - which is
      # also why strict turns it off. A workspace is not a machine anyone
      # rescues by hand, but a rule that costs something has to be able to say
      # so instead of being silently true.
      tags = [ "breaks-debug" ];
      summary = "Magic SysRq is disabled.";
      config =
        { lib, ... }:
        {
          boot.kernel.sysctl."kernel.sysrq" = lib.mkForce 0;
        };
      check = ''
        have=$(cat /proc/sys/kernel/sysrq 2>/dev/null || echo unknown)
        if [ "$have" = "0" ]; then exit 0; fi
        echo "  kernel.sysrq=$have"
        exit 1
      '';
    }
  ];
}

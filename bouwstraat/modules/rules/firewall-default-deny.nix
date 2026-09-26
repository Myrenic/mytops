{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "firewall-default-deny";
      severity = "baseline";
      compliance = [ "bio" ];
      tags = [ ];
      summary = "Inbound traffic is refused except the stream port (and SSH when it is enabled).";
      config =
        { cfg, ... }:
        {
          networking.firewall = {
            enable = lib.mkForce true;
            allowedTCPPorts = lib.mkForce (
              [ cfg.stream.port ] ++ lib.optionals cfg.ssh.enable [ 22 ]
            );
            # Nothing in a workspace listens on UDP; the streams are TCP.
            allowedUDPPorts = lib.mkForce [ ];
          };
        };
      check = ''
        systemctl is-active --quiet nftables || { echo "  nftables is not running"; exit 1; }
        # The NixOS firewall accepts by policy and rejects explicitly, so a
        # missing reject rule is the failure this looks for - a box that
        # "has a firewall" and lets everything in.
        nft list ruleset 2>/dev/null | grep -qE 'reject|drop' || {
          echo "  no reject/drop rule in the ruleset"
          exit 1
        }
      '';
    }
  ];
}

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
      check =
        { cfg, ... }:
        ''
          # `firewall.service`, not `nftables.service`: NixOS's firewall is its own
          # unit (nftables backend, iptables-compatible interface), while
          # nftables.service is a separate optional unit for hand-written rules and
          # is normally inactive. Testing for the latter reported a control that was
          # in place as missing - and the device said so on the console:
          #   PASS apparmor / == firewall-default-deny rc=1 "nftables is not running"
          if ! systemctl is-active --quiet firewall.service; then
            echo "  firewall.service is not running"
            exit 1
          fi
          ruleset=$(nft list ruleset 2>/dev/null || true)
          if ! printf '%s' "$ruleset" | grep -qE 'reject|drop'; then
            echo "  no reject/drop rule in the ruleset"
            exit 1
          fi
          # The control is only in place if the one port a workspace needs is the
          # one it allows: a firewall that rejects everything is not this rule.
          if ! printf '%s' "$ruleset" | grep -q "dport ${toString cfg.stream.port}"; then
            echo "  the stream port ${toString cfg.stream.port} is not explicitly allowed"
            exit 1
          fi
        '';
    }
  ];
}

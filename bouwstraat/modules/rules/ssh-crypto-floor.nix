{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "ssh-crypto-floor";
      severity = "baseline";
      compliance = [
        "bio"
        "ncsc"
      ];
      tags = [ ];
      summary = "SSH, when enabled, offers only modern KEX/ciphers/MACs and takes no passwords or root logins.";
      config =
        { cfg, lib, ... }:
        {
          services.openssh.settings = {
            PasswordAuthentication = lib.mkForce false;
            KbdInteractiveAuthentication = lib.mkForce false;
            PermitRootLogin = lib.mkForce "no";
            KexAlgorithms = lib.mkForce [
              "sntrup761x25519-sha512@openssh.com"
              "curve25519-sha256"
              "curve25519-sha256@libssh.org"
            ];
            Ciphers = lib.mkForce [
              "chacha20-poly1305@openssh.com"
              "aes256-gcm@openssh.com"
              "aes128-gcm@openssh.com"
            ];
            MACs = lib.mkForce [
              "hmac-sha2-512-etm@openssh.com"
              "hmac-sha2-256-etm@openssh.com"
            ];
            AllowUsers = lib.mkForce (
              [ cfg.user.name ] ++ lib.optionals cfg.admin.enable [ cfg.admin.name ]
            );
          };
        };
      check = ''
        if ! systemctl is-active --quiet sshd; then
          # Not a pass: the rule was not evaluated. Distinguishing the two is
          # the difference between a report and a claim.
          echo "  sshd is not running; rule not applicable"
          exit 3
        fi
        if [ "$(id -u)" != "0" ]; then
          echo "  needs root to ask sshd -T"
          exit 3
        fi
        fail=0
        for want in "passwordauthentication no" "permitrootlogin no" "kbdinteractiveauthentication no"; do
          sshd -T 2>/dev/null | grep -qx "$want" || { echo "  missing: $want"; fail=1; }
        done
        exit $fail
      '';
    }
  ];
}

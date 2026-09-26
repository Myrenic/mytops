{ lib, ... }:
let
  # Kernel-level defaults that cost the desktop nothing but close the cheap
  # local levers (pointer/address leaks, ptrace of other processes, redirect
  # games on the pod network).
  expected = {
    "kernel.kptr_restrict" = 2;
    "kernel.dmesg_restrict" = 1;
    "kernel.yama.ptrace_scope" = 1;
    "kernel.unprivileged_bpf_disabled" = 1;
    "kernel.randomize_va_space" = 2;
    "fs.protected_hardlinks" = 1;
    "fs.protected_symlinks" = 1;
    "fs.suid_dumpable" = 0;
    "net.ipv4.conf.all.accept_redirects" = 0;
    "net.ipv4.conf.all.accept_source_route" = 0;
    "net.ipv4.conf.all.send_redirects" = 0;
    "net.ipv4.conf.all.log_martians" = 1;
    "net.ipv4.conf.all.rp_filter" = 1;
    "net.ipv4.icmp_echo_ignore_broadcasts" = 1;
    "net.ipv4.tcp_syncookies" = 1;
  };

  checks = lib.mapAttrsToList (key: value: "  " + key + " " + toString value) expected;
in
{
  mytops.hardening._register = [
    {
      id = "sysctl-baseline";
      severity = "baseline";
      compliance = [
        "bio"
        "ncsc"
      ];
      tags = [ ];
      summary = "Kernel and network sysctls that close local information leaks and redirect/source routing.";
      config =
        { lib, ... }:
        {
          # mkForce, not a default: a consumer may add sysctls but may not
          # weaken these without saying so in a rule (DAWO's ADR-0002).
          boot.kernel.sysctl = lib.mapAttrs (_: v: lib.mkForce v) expected;
        };
      # The check is the same list the configuration was derived from, so the
      # two cannot drift: it is generated, not retyped.
      check = ''
        fail=0
        while read -r key want; do
          [ -n "$key" ] || continue
          have=$(sysctl -n "$key" 2>/dev/null || echo "")
          if [ "$have" != "$want" ]; then
            echo "  $key = $have (want $want)"
            fail=1
          fi
        done <<'EOF'
${builtins.concatStringsSep "\n" checks}
EOF
        exit $fail
      '';
    }
  ];
}

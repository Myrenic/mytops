{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.mytops;
in
{
  options.mytops = {
    enable = lib.mkEnableOption "the mytops workspace baseline" // {
      default = true;
    };

    org = lib.mkOption {
      type = lib.types.str;
      default = "mytops";
      description = "Organisation slug, used in the image labels and the report.";
    };

    # Comes from the mytops API: the workspace object is named
    # ws-<entryId>-<slug>, and the guest should be able to say which one it is.
    # Baked in at build time (not cloud-init) because it is a property of the
    # image, not of the boot.
    workspaceId = lib.mkOption {
      type = lib.types.str;
      default = "mytops-workspace";
      description = "Identifier of the workspace this image belongs to.";
    };

    ssh.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        SSH in the guest. Off by default: a streamed desktop is reached through
        the mytops route, and every extra listener is another thing to defend.
        The hardening register still applies its crypto floor to the sshd
        configuration, so enabling this cannot lower it.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Pinned, not inherited: the image is the thing that must not change its
    # behaviour because the nixpkgs input moved. Bumping it is a deliberate
    # commit with a migration note, exactly like any other release change.
    system.stateVersion = "25.05";

    # Flakes in the guest, so a device can be rebuilt from the same pinned
    # source it was delivered from.
    nix.settings.experimental-features = [
      "nix-command"
      "flakes"
    ];

    # Sovereignty is a build property, not a runtime promise: unfree packages
    # are refused here rather than audited later (DAWO: "no unvetted vendor apps
    # in core"). An overlay that genuinely needs one has to say so explicitly.
    nixpkgs.config.allowUnfree = lib.mkForce false;

    networking.hostName = lib.mkDefault cfg.workspaceId;

    # Time is a dependency of every audit trail this system writes, so it is
    # stated rather than inherited: Dutch pool, and an overlay can point it at
    # an internal source without editing a rule.
    networking.timeServers = lib.mkDefault [
      "0.nl.pool.ntp.org"
      "1.nl.pool.ntp.org"
      "2.nl.pool.ntp.org"
      "3.nl.pool.ntp.org"
    ];

    # An empty NTP list is a device that silently drifts - the kind of mistake
    # that must fail the build rather than show up as a wrong timestamp in an
    # audit trail six months later.
    assertions = [
      {
        assertion = config.networking.timeServers != [ ];
        message = "mytops: networking.timeServers is empty; time sync is a baseline requirement";
      }
    ];

    # The break-glass admin keeps a password; the desktop user does not need
    # wheel (the guest is single-purpose and reached through the authenticated
    # stream).
    security.sudo.wheelNeedsPassword = true;

    services.openssh.enable = cfg.ssh.enable;

    # Machine identity for the report the API can read later.
    environment.etc."mytops/image.json".text = builtins.toJSON {
      org = cfg.org;
      workspaceId = cfg.workspaceId;
      builtBy = "bouwstraat";
    };

    environment.systemPackages = [ pkgs.jq ];
  };
}

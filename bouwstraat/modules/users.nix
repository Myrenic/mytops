{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.mytops;

  # The desktop user is uid 1000 for the same reason every container workspace
  # is: the per-user home volume is created by the home agent and handed to
  # uid 1000, so the VM guest has to be that uid or the profile is not writable.
  uid = cfg.user.uid;
in
{
  options.mytops.user = {
    name = lib.mkOption {
      type = lib.types.str;
      default = "user";
      description = "The person using the desktop.";
    };

    uid = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1000;
      description = ''
        Must stay 1000. The mytops home volume is chowned to 1000 by the home
        agent, and a container workspace and a VM workspace share one profile.
      '';
    };

    initialPassword = lib.mkOption {
      type = lib.types.str;
      default = "user";
      description = ''
        Bootstrap password for the local console. The desktop is reached through
        the authenticated route, not a password prompt, so this exists for
        break-glass at a keyboard; change it (or set it per host) before any
        image leaves a lab.
      '';
    };

    extraGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
  };

  options.mytops.admin = {
    enable = lib.mkEnableOption "a local break-glass administrator" // {
      default = true;
    };

    name = lib.mkOption {
      type = lib.types.str;
      default = "beheer";
    };

    sshKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Public keys for the administrator. They are baked into the image so a
        device that never reaches cloud-init is still reachable from its own
        console.
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        users.users.${cfg.user.name} = {
          isNormalUser = true;
          uid = uid;
          home = "/home/" + cfg.user.name;
          description = "mytops desktop user";
          initialPassword = cfg.user.initialPassword;
          extraGroups = cfg.user.extraGroups;
          # The home is the mounted home volume. Letting activation create it
          # would put a directory in the way of the mount, and its contents
          # would then hide the user's files rather than be them.
          createHome = false;
        };
      }

      (lib.mkIf cfg.admin.enable {
        users.users.${cfg.admin.name} = {
          isNormalUser = true;
          description = "mytops break-glass administrator";
          initialPassword = "change-me";
          extraGroups = [ "wheel" ];
          openssh.authorizedKeys.keys = cfg.admin.sshKeys;
        };
      })
    ]
  );
}

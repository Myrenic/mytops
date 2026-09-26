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
  options.mytops.home = {
    enable = lib.mkEnableOption "the per-user home volume" // {
      default = true;
    };

    # The volume is mounted *as* the user's home rather than next to it. In the
    # container runtime the API mounts the same Longhorn claim at /config and
    # the linuxserver images call that the profile; a VM cannot mount a PVC from
    # another namespace, so it gets the NFS export of the same claim - and the
    # honest place for a user's whole home in a workspace is the home itself.
    # This is what makes a VM workspace and a container workspace share one
    # profile, and what makes destroying a workspace lose no work.
    mountPoint = lib.mkOption {
      type = lib.types.str;
      default = "/home/" + cfg.user.name;
    };

    # Written by cloud-init (the API knows the export name only at launch: the
    # Longhorn share-manager Service is named after the bound PersistentVolume).
    sourceFile = lib.mkOption {
      type = lib.types.str;
      default = "/run/mytops/home-source";
    };
  };

  config = lib.mkIf (cfg.enable && cfg.home.enable) {
    systemd.services.mytops-home = {
      description = "Mount the mytops home volume";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      # cloud-config.service, NOT cloud-final.service. The API's user-data ends
      # with `systemctl restart mytops-home.service`, which runs in cloud-final -
      # so ordering this unit after cloud-final deadlocks the boot: cloud-final
      # waits for the restart, the restart waits for cloud-final (which is
      # already running, so systemd does not treat it as an ordering cycle), and
      # the entire desktop chain sits "waiting" behind a cloud-init that never
      # finishes. It hung for eight minutes on the first boot of this image.
      #
      # The file this unit needs is written by the config stage, so waiting for
      # cloud-config is both sufficient and safe; the runcmd restart stays as a
      # second attempt for a launch whose seed arrives late.
      after = [
        "network-online.target"
        "cloud-config.service"
      ];
      # Everything that shows the user a screen waits for this: a desktop that
      # starts before the home is mounted has its session written to the root
      # disk and looks, to the user, exactly like losing their files.
      before = [
        "mytops-xvfb.service"
        "mytops-desktop.service"
        "display-manager.service"
      ];
      path = with pkgs; [
        util-linux
        nfs-utils
        coreutils
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Environment = [
          "MOUNT_POINT=${cfg.home.mountPoint}"
          "SOURCE_FILE=${cfg.home.sourceFile}"
          "OWNER_UID=${toString cfg.user.uid}"
          "OWNER_NAME=${cfg.user.name}"
          # By absolute path, because `mount -t nfs` never found the helper:
          # util-linux's mount looks for /sbin/mount.nfs (a compiled-in path that
          # does not exist here) and falls back to a bare mount(2) with the string
          # as the device, which the kernel rejects with "NFS: mount program
          # didn't pass remote address". The unit has nfs-utils on its PATH and
          # still lost that lookup, so the helper is named outright.
          "MOUNT_NFS=${pkgs.nfs-utils}/bin/mount.nfs"
        ];
      };
      # Kept in the repository as a shell script so it can be read, grepped and
      # reviewed like the rest of the system - not buried in a Nix string.
      script = builtins.readFile ./home-mount.sh;
    };
  };
}

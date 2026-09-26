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
  options.mytops.cloudInit = {
    enable = lib.mkEnableOption "cloud-init, driven by the mytops API" // {
      default = true;
    };

    datasource = lib.mkOption {
      type = lib.types.enum [
        "NoCloud"
        "ConfigDrive"
      ];
      default = "NoCloud";
      description = ''
        NoCloud is what KubeVirt's cloudInitNoCloud volume is: the API writes the
        user-data into a Secret and the VMI references it. ConfigDrive is the
        other KubeVirt-native option and is kept selectable because the choice is
        a platform one, not an image one.
      '';
    };
  };

  config = lib.mkIf (cfg.enable && cfg.cloudInit.enable) {
    services.cloud-init.enable = true;

    # Only the datasource is fixed here; cloud-init's own network configuration
    # is left off because the pod network already hands the guest its address
    # over DHCP, and a second network writer on the same interface is a race
    # nobody wins.
    services.cloud-init.network.enable = false;

    services.cloud-init.settings = {
      datasource_list = [ cfg.cloudInit.datasource ];
    };

    # /run/mytops is the hand-off from cloud-init (which runs early, as root)
    # to the services that need a runtime value the image cannot know: the NFS
    # source of this user's home volume.
    systemd.tmpfiles.rules = [
      "d /run/mytops 0755 root root -"
    ];
  };
}

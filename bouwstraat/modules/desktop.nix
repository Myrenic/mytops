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
  options.mytops.desktop = {
    enable = lib.mkEnableOption "a desktop environment in the image" // {
      default = true;
    };

    environment = lib.mkOption {
      type = lib.types.enum [
        "xfce"
        "none"
      ];
      default = "xfce";
      description = ''
        Which desktop the session starts. xfce because it is the one that runs
        comfortably on a software-rendered framebuffer inside a VM - the same
        reason the Containerfile-era workspace used it below the Wayland path.
        "none" is a real option: an infrastructure or jump workspace should not
        carry a desktop it will never start.
      '';
    };

    apps = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        xfce.xfce4-terminal
      ];
      example = lib.literalExpression "with pkgs; [ firefox xfce.xfce4-terminal ]";
      description = "Applications baked into the image. Anything the user adds themselves lands in their home volume.";
    };

    sessionCommand = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default =
        if cfg.desktop.environment == "xfce" then
          "${pkgs.xfce.xfce4-session}/bin/xfce4-session"
        else
          "true";
      description = "The session binary the streamed display runs.";
    };
  };

  config = lib.mkIf (cfg.enable && cfg.desktop.enable) {
    assertions = [
      {
        assertion = cfg.desktop.environment != "none" || !cfg.stream.enable;
        message = "mytops.desktop.environment = none cannot be combined with mytops.stream.enable = true: there is no session to stream";
      }
    ];

    # No display manager and no X server module: the session runs on the Xvfb
    # display that modules/stream.nix owns. Enabling services.xserver would add
    # a second thing that thinks it owns the console, and neither KubeVirt's
    # virtio-gpu nor a headless guest needs it.
    security.polkit.enable = true;

    environment.systemPackages =
      cfg.desktop.apps
      ++ lib.optionals (cfg.desktop.environment == "xfce") (with pkgs; [
        xfce.exo
        xfce.xfce4-settings
        xfce.tumbler
        shared-mime-info
        desktop-file-utils
      ]);
  };
}

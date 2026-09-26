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
  options.mytops.image = {
    enable = lib.mkEnableOption "a bootable disk image" // {
      default = true;
    };

    diskLabel = lib.mkOption {
      type = lib.types.str;
      default = "nixos";
      description = "Filesystem label the root is mounted by.";
    };
  };

  config = lib.mkIf (cfg.enable && cfg.image.enable) {
    # A headless KubeVirt guest must never sit at a boot menu, and it must say
    # something while it boots: without console=ttyS0 nothing reaches the serial
    # log, so "the VM is running and the desktop never answers" has no evidence
    # attached to it (`virtctl console` shows a blank screen). Both are here
    # because that diagnosis cost an afternoon.
    boot.kernelParams = [
      "console=tty0"
      "console=ttyS0,115200"
    ];

    boot.loader.timeout = lib.mkDefault 1;

    # The serial console is an operator's way in when the stream is the thing
    # that is broken. Not autologin: whoever uses it authenticates.
    systemd.services."serial-getty@ttyS0".enable = lib.mkDefault true;

    boot.loader.grub = {
      enable = true;
      # The VMI in api/server.mjs asks for machine type q35 with the default
      # (SeaBIOS) firmware and boots the imported disk, so the image carries a
      # legacy-partitioned GRUB. EFI would need `firmware` on the VMI spec and a
      # different image - a coherent change, but one that has to happen on both
      # sides at once.
      device = "/dev/vda";
      efiSupport = false;
    };

    fileSystems."/" = {
      device = "/dev/disk/by-label/${cfg.image.diskLabel}";
      fsType = "ext4";
    };

    # KubeVirt reports a VM as Running from the hypervisor's point of view; the
    # guest agent is what lets it say something true about the guest, and it is
    # what `printableStatus` refines.
    services.qemuGuest.enable = true;

    # The image itself. make-disk-image is nixpkgs' own builder (the same code
    # nixos-generators wraps), used directly so the bouwstraat takes no extra
    # flake input for one artifact.
    #
    # Interpolated, not `pkgs.path + "/nixos/..."`: `+` on a path strips a
    # leading slash from the string, so the concatenating form points at
    # `<store-path>nixos/lib/make-disk-image.nix` - a path that does not exist.
    system.build.qcow2 = import "${pkgs.path}/nixos/lib/make-disk-image.nix" {
      inherit config lib pkgs;
      format = "qcow2";
      partitionTableType = "legacy";
      # Explicit, and the same value the root filesystem is mounted by: the
      # builder's default happens to match, but a guest that cannot find its root
      # has no console to complain on.
      label = cfg.image.diskLabel;
      # "auto" sizes the filesystem from the closure instead of guessing, so a
      # bigger app set does not silently produce an image that no longer fits.
      diskSize = "auto";
    };
  };
}

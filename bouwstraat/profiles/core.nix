# The mandatory tier: the blocks every mytops workspace has, and the register
# they are selected through.
#
# A consumer imports this and configures it through options; it cannot drop a
# block from it. That is deliberate (DAWO's profiles-dawo-core): the difference
# between a baseline and a suggestion is whether it can go missing when someone
# is in a hurry.
{ lib, ... }:
{
  imports = [
    ../modules/base.nix
    ../modules/users.nix
    ../modules/cloud-init.nix
    ../modules/home.nix
    ../modules/hardening.nix
    ../modules/desktop.nix
    ../modules/stream.nix
  ];

  # Defaults, not forces: an org overlay may raise the level, and the register
  # is what decides which rules exist. Lowering it below baseline is possible
  # and shows up in the image's report as exactly that.
  mytops.hardening.level = lib.mkDefault "baseline";
  mytops.hardening.compliance = lib.mkDefault [ "bio" ];

  # Nothing in the image participates in telemetry, and nothing should be able
  # to turn it on from here.
  services.openssh.enable = lib.mkDefault false;
}

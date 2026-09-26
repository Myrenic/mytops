# The opt-in tier: blocks that cost the user something or are not ready.
#
# Importing this only sets a higher default level - the register still decides
# what that means, and a host can still take one rule out by id. This is where a
# control that is genuinely disruptive belongs, so that saying yes to hardening
# in general does not mean saying yes to every control in particular.
{ lib, ... }:
{
  imports = [ ./core.nix ];

  mytops.hardening.level = lib.mkDefault "hardened";
}

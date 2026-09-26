# The workspace the mytops catalog calls `nixos-desktop`.
#
# This file is the third layer of the consumer model: it chooses the tiers and
# the app set, and it is the only place that knows this image is a streamed
# desktop rather than an infrastructure box.
{ pkgs, ... }:
{
  imports = [
    ../image.nix
    ../../profiles/hardened.nix
  ];

  mytops.workspaceId = "mytops-vm-desktop";

  mytops.desktop.apps = with pkgs; [
    firefox
    xfce.xfce4-terminal
    xfce.thunar
  ];

  mytops.hardening = {
    # Secure by default, opt out where it breaks the user (DAWO's ROADMAP 0.2
    # position, which is the one that survived contact with a pilot).
    level = "hardened";
    compliance = [ "bio" ];

    # The one deliberate opt-out, with the reason written down instead of the
    # control quietly missing: a workspace that refuses the USB stick someone
    # just plugged in reads as broken, and this image is a desktop people touch.
    # Flip it here, or take the level to strict, when a host really means it.
    excludeTags = [ "breaks-usb" ];
  };

  # No admin key is baked into a public repository. An org overlay sets these
  # for its own fleet; until then the break-glass account has a password and a
  # console, which is enough to get in and not enough to leak.
  mytops.admin.sshKeys = [ ];
}

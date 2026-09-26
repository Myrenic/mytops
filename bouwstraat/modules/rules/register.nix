# The register, as a value.
#
# Every rule file in this directory is written as a NixOS module fragment
# (`{ mytops.hardening._register = [ ... ]; }`), so a rule declares itself in
# exactly one place and nothing has to list them twice.
#
# It is read here as *data*, outside the system config, and that is not a
# stylistic choice: a module that has to read its own options to know what it
# configures cannot be evaluated at all. DAWO keeps its rules in the flake scope
# for the same reason (flake.dawo.rules); this is the same move without taking a
# flake-parts dependency.
{ lib }:
let
  entries = builtins.attrNames (builtins.readDir ./.);

  # Path interpolation, not `./. + "/" + name`: `+` on a path strips a leading
  # slash from the string, so the concatenating form silently produced
  # `modules/rulesapparmor.nix` - a path that does not exist.
  files = map (name: ./. + "/${name}") (
    builtins.filter (
      name: name != "register.nix" && builtins.match "[^.]+\\.nix" name != null
    ) entries
  );

  # A rule file is `{ lib, ... }: { mytops.hardening._register = [ ... ]; }`:
  # it takes lib (and ignores the rest) so the register can read it without a
  # system config, and it declares itself as a module fragment so nothing lists
  # rules twice.
  rules = file: (import file { inherit lib; }).mytops.hardening._register or [ ];
in
builtins.concatLists (map rules files)

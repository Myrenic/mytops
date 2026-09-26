# The hardening register.
#
# DAWO's shape (its ADR-0010), adopted here because it survived a real pilot:
# controls are *rules* in one register, and a device selects them on two
# independent axes.
#
#   level      - ordered: none < baseline < hardened < strict
#   compliance - a set: a norm (bio, ncsc) asks for specific rules, some of
#                which sit in baseline and some of which sit nowhere
#
# Squeezing compliance into the ordered scale would force a wrong answer to
# "is compliance stricter than hardened", which is why there are two.
#
# On top of both: `excludeTags` vetoes rules by tag (a streamed workspace
# legitimately cannot have, say, a locked screen), and a per-rule switch wins
# over everything. A register where 19 of 20 rules need a fork is not a register.
{ config, lib, pkgs, ... }:
let
  cfg = config.mytops.hardening;

  levelRank = {
    none = 0;
    baseline = 1;
    hardened = 2;
    strict = 3;
  };

  rankOf = severity: levelRank.${severity} or 99;

  # Read as data, not from config: a module that has to read its own options to
  # know what it configures is a cycle (docs/pitfalls.md has the trace). This is
  # the same move DAWO makes by keeping its rules in the flake scope.
  register = import ./rules/register.nix { inherit lib; };

  selectedByLevel = rule: rankOf rule.severity <= levelRank.${cfg.level};
  selectedByNorm = rule: builtins.any (norm: builtins.elem norm (rule.compliance or [ ])) cfg.compliance;
  vetoed = rule: builtins.any (tag: builtins.elem tag (rule.tags or [ ])) cfg.excludeTags;

  # Precedence, stated once:
  #   rules.<id> = false  -> off, whatever else says
  #   rules.<id> = true   -> on, even if a tag would have vetoed it
  #   excludeTags         -> off, even if a level or a norm selected it
  #   otherwise           -> on when the level or a norm selects it
  decision =
    rule:
    let
      forced = cfg.rules.${rule.id} or null;
    in
    if forced == false then
      false
    else if forced == true then
      true
    else if vetoed rule then
      false
    else
      selectedByLevel rule || selectedByNorm rule;

  active = builtins.filter decision register;
  inactive = builtins.filter (r: !(decision r)) register;

  describe =
    rule: enabled: {
      id = rule.id;
      severity = rule.severity;
      compliance = rule.compliance or [ ];
      tags = rule.tags or [ ];
      summary = rule.summary;
      # A check is a string, or a function of the mytops options for the rules
      # that need a value from the configuration (the stream port a firewall must
      # allow). Rendering it here keeps the report the single thing the device
      # executes, and keeps one source of truth for that value.
      check =
        if builtins.isFunction rule.check then
          rule.check {
            inherit lib;
            cfg = config.mytops;
          }
        else
          rule.check;
      enabled = enabled;
    };

  report = {
    level = cfg.level;
    compliance = cfg.compliance;
    excludeTags = cfg.excludeTags;
    rules = map (r: describe r true) active ++ map (r: describe r false) inactive;
  };

  # The on-device proof. A control that is configured but not verified is a
  # claim, and the whole point of the register is that the claim can be checked
  # on the running machine by whoever is looking at it.
  verify = pkgs.writeShellApplication {
    name = "mytops-verify";
    # Every binary a rule's check may call has to be here: a missing one is not
    # "unknown", it is command-not-found, which verify.sh would report as a
    # violated rule - the opposite of the truth.
    runtimeInputs = with pkgs; [
      jq
      coreutils
      gnugrep
      procps # sysctl, ps
      nftables # nft
      systemd # systemctl, timedatectl
      openssh # sshd -T
      util-linux # mountpoint - the home-mounted rule
    ];
    text = builtins.readFile ./hardening-verify.sh;
  };
in
{
  options.mytops.hardening = {
    level = lib.mkOption {
      type = lib.types.enum [
        "none"
        "baseline"
        "hardened"
        "strict"
      ];
      default = "baseline";
      description = "Ordered strictness level; selects every rule at or below it.";
    };

    compliance = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "bio" ];
      description = "Norms that ask for specific rules regardless of the level.";
    };

    excludeTags = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "breaks-stream" ];
      description = ''
        Tags to veto. This is how a workspace keeps a control it structurally
        cannot have (a streamed desktop cannot lock its screen and still be
        streamed) without weakening the rules everyone else gets.
      '';
    };

    rules = lib.mkOption {
      type = lib.types.attrsOf (lib.types.nullOr lib.types.bool);
      default = { };
      example = { "ssh-crypto-floor" = false; };
      description = "Per-rule switch; wins over level, compliance and excludeTags.";
    };

    # What this device actually has on, in register order. Reported here rather
    # than derived by a caller so the selection logic lives in one place, and so
    # the gate can assert that a machine is not silently running with none.
    activeRuleIds = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      readOnly = true;
      description = "The hardening rules that are enabled on this device.";
    };
  };

  config = lib.mkMerge (
    # mkIf over *every* rule, not a filtered list: `filter decision register`
    # forces the selection - and therefore `config.mytops.hardening` - while the
    # merge itself is being constructed, which is a cycle (the module system
    # needs this module's config to know what option values are, and this module
    # needs the option values to know what its config contains). `mkIf` keeps the
    # list static and lets the condition be evaluated per option, where reading
    # another option's value is ordinary.
    #
    # The fragments are still only *built* when their condition holds, so `cfg`
    # is passed as before.
    map (rule: lib.mkIf (decision rule) (rule.config { inherit lib pkgs; cfg = config.mytops; })) register
    ++ [
      {
        # Computed here, not as an option default: a default that reads
        # `config.mytops.hardening` is evaluated while the options themselves are
        # being built, which is a cycle (the module argument `config` gets forced
        # before `config` exists). In `config` the same expression is ordinary.
        environment.etc."mytops/hardening.json".text = builtins.toJSON report;
        environment.systemPackages = [ verify ];
        mytops.hardening.activeRuleIds = map (rule: rule.id) active;

        assertions = [
          {
            # A typo in rules.<id> would otherwise silently do nothing - the
            # exact failure mode this register exists to prevent.
            assertion = builtins.all (
              id: builtins.any (rule: rule.id == id) register
            ) (builtins.attrNames cfg.rules);
            message =
              "mytops.hardening.rules names a rule that is not in the register: "
              + builtins.concatStringsSep ", " (
                builtins.filter (
                  id: !(builtins.any (rule: rule.id == id) register)
                ) (builtins.attrNames cfg.rules)
              );
          }
          {
            assertion = register != [ ];
            message = "mytops.hardening register is empty; the register module was not imported";
          }
        ];
      }
    ]
  );
}

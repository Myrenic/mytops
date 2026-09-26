# Adding a hardening rule

A rule is a file in `modules/rules/`. `modules/rules/all.nix` imports every one
of them, so there is no list to update and no way for a rule to be silently
absent.

## The shape

```nix
{ lib, ... }:
{
  mytops.hardening._register = [
    {
      id = "printers-off";                 # stable: it is what hosts switch off by name
      severity = "hardened";               # baseline | hardened | strict
      compliance = [ "bio" ];              # norms that ask for it regardless of level
      tags = [ "breaks-printing" ];        # excludeTags can veto it
      summary = "CUPS is not running.";
      config = { lib, ... }: {
        services.printing.enable = lib.mkForce false;
      };
      check = ''
        systemctl is-active --quiet cups && exit 1
        exit 0
      '';
    }
  ];
}
```

- `config` receives `{ lib, pkgs, cfg }` where `cfg` is `config.mytops` — the
  mytops options, not the whole system config. That is deliberate: a fragment can
  read what it needs to decide, and cannot accidentally depend on the value it is
  setting.
- Use `lib.mkForce` for a value that must not be weakened and `lib.mkDefault`
  for one a consumer may replace.
- `check` runs on the device. `exit 0` = holds, `exit 1` = violated, `exit 3` =
  could not be evaluated (needs root, service not running, clock not synced yet).
  Anything else counts as violated. Do not write a check that returns 0 when it
  cannot tell.

## How a rule is selected

| Mechanism | Effect |
| --- | --- |
| `level` | selects every rule whose `severity` is at or below it |
| `compliance` | selects a rule by norm, whatever its severity |
| `excludeTags` | vetoes a rule by tag, even when a level or a norm selected it |
| `rules.<id>` | wins over all of the above, in both directions |

Precedence, once: `false` beats everything; `true` beats the veto; the veto beats
level and norm; otherwise the level or a norm decides.

## Adding a rule that costs something

Tag it. `breaks-usb` and `breaks-debug` are already in use: the tag documents the
cost, and a host that wants the control anyway sets the rule to `true` (which
overrides the veto) with a comment saying why. A rule that quietly wins an
argument it should have had in the open is worse than no rule.

## Seeing what a machine actually has

```sh
mytops-verify                      # as root for the full set
jq . /etc/mytops/hardening.json     # the register as built, with every check
cat /run/mytops/hardening-result.json   # the last root run's result
```

`/etc/mytops/hardening.json` is generated at build time from the same data the
image was configured with, so the report and the configuration cannot disagree
about what was supposed to happen — only about whether it did.

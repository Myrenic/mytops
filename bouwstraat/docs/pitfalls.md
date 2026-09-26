# Pitfalls

Things that cost time here, written down so they cost the next person minutes.
Every entry is one that actually happened while this was built, not one that
might.

## A module cannot build its own contribution list out of its own options

The register took three attempts. The first two both died with

```
error: infinite recursion encountered
  … while evaluating the module argument `config` in "bouwstraat/modules/hardening.nix"
```

because the register was *read out of the system config*:

```nix
config = lib.mkMerge (map (rule: ...) active);   # active = filter decision register
# with register = cfg._register, cfg = config.mytops.hardening
```

Two wrong fixes are worth naming, because they look right:

- **Reading it in an option default.** `reportFile = mkOption { default =
  toJSON (f config.mytops.hardening); }` forces the module argument `config`
  while the options themselves are still being built. Cycles immediately.
- **Swapping `filter decision register` for `mkIf (decision rule)` over every
  rule.** That does make the conditions lazy, but the *list* still needs
  `register` from `config`, and `mkMerge` has to evaluate its list structure to
  build the merge. Still a cycle - and the error is identical, which is what
  makes it worth writing down.

**What actually works.** The register is a plain value, read from the rule files
directly (`modules/rules/register.nix`), so nothing needs `config` to know what
rules exist. Selection stays an option and is applied per rule in `mkIf`, where
reading another option's value is ordinary. DAWO reached the same conclusion by
keeping its rules in the flake scope (`flake.dawo.rules`); this is the same move
without a flake-parts dependency.

The rule of thumb: **a module may read its own options in option values and in
`mkIf` conditions, but never in anything that decides the shape of its own
contribution.**

## `+` on a path eats the slash

```nix
./. + "/rules/" + name     # -> modules/rulesapparmor.nix  (does not exist)
./. + "/rules/${name}"     # -> modules/rules/apparmor.nix (correct)
```

Nix's `+` with a path on the left appends the string *after removing a leading
slash*, and inserts nothing in its place. Verified in this repository with a
three-line eval, because it is the kind of thing that reads as obviously right.

**How to recognise it.** `error: Path 'modules/rulesapparmor.nix' does not exist
in Git repository` - a path that looks like two names glued together, because
that is exactly what happened.

## A flake inside a git repository only sees tracked files

`error: Path 'bouwstraat/modules/profiles/hardened.nix' does not exist in Git
repository` was a wrong relative import (`../profiles` from `modules/hosts/`).
The same error appears for a *correct* path that is untracked: the git-backed
flake source is the index, so a file that exists on disk and was never
`git add`ed does not exist as far as the evaluator is concerned.

**What to do.** `git add` before you build, and read the "Git tree is dirty"
warning as information rather than noise - a dirty tree also means every
relative path inside the flake resolves to a fresh store path, so a comparison
that says "everything changed" is telling you about the tree, not the change.

## A systemd unit without a `path` has no coreutils

A `ExecStartPre` wait loop that calls `seq` and `sleep` works in a shell and
fails in a unit: systemd gives a service `/usr/bin:/bin`, and on NixOS nothing
lives there. The unit restarts forever with `command not found` in the journal.

**What to do.** `path = [ pkgs.coreutils ];` on the units that run shell, and
the same for anything the script may call (`util-linux` for `mountpoint`,
`nfs-utils` for `mount`). `mytops-verify` has the matching hazard in the other
direction: a missing binary is command-not-found, which a naive verifier reports
as a *violated rule* - the opposite of the truth. Every binary a rule's check
may call is listed in `runtimeInputs`.

## `/run/mytops` is a hand-off, and hand-offs have ordering

cloud-init runs early as root and writes the NFS source; the systemd service
that mounts it runs later and reads it. The file must exist before the unit
starts, and the unit must be after `cloud-config.service` *and*
`cloud-final.service` - cloud-init's `runcmd` is the final stage, and a unit
that only waits for the config stage can start with the seed half-applied.

**How to recognise it.** A workspace that boots, offers a desktop, and has an
empty home - with `mytops-home` reporting "no home source". Nothing errors,
because starting without a home is a legitimate outcome for an ephemeral entry;
the difference is only visible in the log line.

## The home mount fails silently by design

`home-mount.sh` continues when the mount fails, on purpose: a desktop with a
throwaway home beats no desktop, and the user is not blocked by a storage blip.
The cost is that the failure is a log line, not a visible error — so the check
that matters is `findmnt /home/user` on a real launch, not "the workspace
started".

**What to do.** Treat "the desktop came up" and "the profile is on the volume"
as two separate acceptance steps. `mytops-verify` reports the home as a rule for
the same reason.

## `$` in `api/server.mjs` is a loaded gun

That file ships as a plain ConfigMap value, so Flux's `postBuild` runs
`envsubst` over it: a `${...}` sequence anywhere - including inside a comment -
is replaced, with an empty string when the name is unknown. The build fails on
it (`webui/scripts/build-configmap.mjs`), which is why the API is written with
string concatenation and why the idle-culler script is stored base64.

**What to do.** When adding code to the API, no template literals. When adding a
*new* file that needs them, ship it as `binaryData` (like `home-agent.mjs`) and
say why in the comment.

## A digest is not a tag

`ubuntu-desktop` uses `ghcr.io/linuxserver/webtop:ubuntu-kde` and always has;
that is the status quo and `verify-catalog.mjs` warns about it rather than
failing. A bouwstraat entry is different: a tag is repointed by whoever controls
the registry, and the catalog is the only thing standing between that and every
workspace launch. Hence `@sha256:` **required** for `vm-*` entries, enforced in
two places (the build script and the verifier) because either one alone can be
bypassed by the other's normal use.

## The gate exists because CI lies

DAWO's version of this: a fixed-output derivation already present in a runner's
store is never fetched again, so `main` stopped evaluating on fresh machines
while CI stayed green on the runner that still had the tarball. The same class of
failure here is a flake that evaluates only where the store already has the
paths.

**What to do.** The gate forces every host's `toplevel.drvPath` on a clean
checkout, and the register check fails if the register is empty - an empty
register would otherwise be a successful gate over a system with no hardening at
all.

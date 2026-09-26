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

## make-disk-image needs `/dev/kvm`, and it fails late and confusingly

Building the qcow2 on a machine without KVM:

```
building '/nix/store/…-closure-info.drv'...
error: Cannot build '/nix/store/…-nixos-disk-image.drv'.
       Reason: missing system features
       Required features: {kvm}
       Available features: {benchmark, big-parallel, nixos-test, uid-range}
```

Two things make this worth a paragraph. It appears **after the entire system
closure has been built** - minutes of work that looks like progress and then
reads as a builder-configuration problem. And it is not a bug in the flake:
`nixpkgs/lib/make-disk-image.nix` line 636 is `pkgs.vmTools.runInLinuxVM (...)`,
because installing GRUB into the image means booting a small VM, and that
derivation requires the `kvm` system feature.

**What to do.** Build where `/dev/kvm` exists, and tell nix it may use it:

```sh
NIX_CONFIG='system-features = benchmark big-parallel nixos-test kvm
sandbox = false' nix build .#packages.x86_64-linux.qcow2
```

A workstation in a VM without nested virtualisation cannot do this at all; the
cluster nodes can (KubeVirt is running on them, so they must), and GitHub's
runners can. `bouwstraat/cluster/build-in-cluster.yaml` is that build as a Job -
it mounts `/dev/kvm`, sets the system feature, and pushes the result to the
registry in one step. On the host this repository was developed on, that Job is
the only way the qcow2 gets built.

## A rebase mid-build makes files vanish

`error: file '/src/bouwstraat/modules/home-mount.sh' does not exist` - while the
file was right there, tracked, and had evaluated fine minutes earlier. The flake
source for a dirty git tree is the *working tree*, and a rebase checks it out
file by file: the build's copy raced the checkout and looked at the repository
mid-rewrite. Nothing was wrong with the file.

**What to do.** Do not rewrite the tree (rebase, checkout, stash) while a build
is running. Nothing about the error will tell you that is what happened.

## A cloud-init runcmd that restarts a unit ordered after cloud-final deadlocks

The user-data ends with `systemctl restart mytops-home.service`, and
`mytops-home.service` was ordered `After=cloud-final.service`. cloud-final runs
the `runcmd` stage, so it waited for the restart; the restart waited for
cloud-final to finish; and because cloud-final was already running, systemd did
not see an ordering *cycle* to break. The boot simply sat there:

```
JOB UNIT                   TYPE  STATE
94  cloud-final.service    start running     ← 8 minutes, and counting
101 mytops-home.service    start waiting
76  mytops-xvfb.service    start waiting
1   multi-user.target      start waiting
```

Outside, everything looked healthy: the VMI was Running, cloud-init had written
`/run/mytops/home-source`, the login prompt worked, and every `mytops-*` unit was
enabled with its symlink in place.

**What to do.** Order the unit after the stage that *writes* what it needs
(`cloud-config.service`, where `write_files` runs), not after the stage that
*calls* it. If a runcmd has to poke a unit, that unit must not be waiting for the
runcmd's own stage - systemd will not save you from that one.

## An initrd without virtio_blk makes a running VM with no disk

The first boot of the first built disk reached stage 1 and stopped:

```
<<< NixOS Stage 1 >>>
waiting for device /dev/disk/by-label/nixos to appear....................
mount: can't find /mnt-root/ in /proc/mounts
stage 2 init script (/mnt-root//nix/store/…-nixos-system-…/init) not found
```

Everything looked healthy from outside: the DataVolume imported, the VMI was
Running and Ready, the virt-launcher pod was 2/2. Inside, KubeVirt had attached
the disk as **virtio** and the initrd had no `virtio_blk`, so stage 1 waited for a
device that could never appear. `boot.initrd.availableKernelModules` in
`modules/image.nix` is the fix, and it doubles as what the NoCloud seed disk needs.

**What to do when a guest does nothing.** Look at it, don't infer it: the serial
console (`virtctl console`, and now `console=ttyS0,115200` in the image) names the
stage and the device it is waiting for. `virt-serial0-log` inside the
virt-launcher pod has the same output, readable with `kubectl exec` when nobody
wants an interactive session.

## A multi-GB blob cannot be pushed through the public hostname

`skopeo copy` to the forge died with `413 Payload Too Large` - the forge is behind
Cloudflare, and Cloudflare caps request bodies (100 MB on the free plan). No
amount of retrying fixes that, and pulling multi-GB images from a public registry
on every workspace launch pays the same path each time.

**What to do.** Serve the disk from the cluster (`base/mytops-images`) and pin it
by checksum: the catalogue gets `diskUrl` + `source.sha256`, the importer reads
it over the pod network, and nothing crosses the edge. `PUSH_REGISTRY=1` keeps the
registry path available for anyone whose registry is directly reachable.

## A nix store on a volume kept being wrong

Three attempts, three symptoms: a malformed `db.sqlite` (node hostPath), a hash
mismatch importing a substituted path (Longhorn), and `path '…-root-profile-env'
is not a valid store path` from a profile written to the same volume. The
container's own writable layer completed a full build on the first attempt.

**What to do.** Accept the download. A build store that is occasionally wrong is
worse than one that is occasionally slow, because the failure surfaces as a
mismatch somewhere else - in the disk image, in the tar, in the guest. Bare
`nix-store --verify --repair` is worth adding if you do persist a store; it was
not enough here.

## RWX for the image store, not a scale-down dance

The image store started ReadWriteOnce, which meant the build job and nginx could
not mount it at once - so installing a disk required scaling nginx to zero first.
That failed in the usual way: the volume stayed attached on another node, the
build pod sat in `ContainerCreating` with `FailedAttachVolume`, and unsticking it
meant deleting a pod and a stale `VolumeAttachment` by hand. Then the new pod
blocked the PVC's deletion through the protection finalizer, so the volume could
neither be released nor replaced.

**What to do.** RWX (what the user home volumes already use). A build installs a
new disk while the store keeps serving, and none of the above is reachable.

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

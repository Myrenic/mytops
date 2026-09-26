# Sovereignty: what the bouwstraat depends on

The workspace images are built from other people's source. That is fine and
unavoidable; what matters is knowing exactly what, and being able to keep
building when a host disappears or an upstream decides to drift.

DAWO's `sovereignty-zero-deps.md` does this audit openly (15 flake inputs, all
GitHub, 2 foreign binary caches, then a five-phase plan), and the audit is the
part worth copying: a dependency you have not counted is a dependency you cannot
replace.

## Where mytops stands

| Dependency | What it is | Reachable how |
| --- | --- | --- |
| `nixpkgs` (pinned rev in `flake.lock`) | the whole package set and the NixOS module system | `github.com`, tarball |
| `cache.nixos.org` | binary substituter, so builds are downloads | HTTPS |
| `registry.tuntelder.com` (or whatever `REGISTRY` names) | where the built disk is pushed and pulled from | your own infrastructure |
| the public Ubuntu cloud image | only for `ubuntu-vm`, which is not a bouwstraat entry | `cloud-images.ubuntu.com` |

The image itself is reproducible from `flake.lock` and this repository; that is
the property to protect, because it is the one that survives an upstream
vanishing.

## What to do, in the order that pays

1. **Keep `flake.lock` committed and pinned to revisions.** Already the case -
   `flake.nix` names a branch, the lock names a revision, and the gate fails if
   the two ever disagree about what was built. An update is then a reviewed
   commit, not something that arrives between two builds.
2. **Mirror `nixpkgs` to infrastructure you control.** One git mirror plus one
   binary cache (attic or harmonia) reached over your own network, with
   `nix.settings.substituters` pointed at it and `cache.nixos.org` dropped. This
   is the single change that turns "we depend on GitHub" into "we depend on
   ourselves" - and it is exactly the change that makes building possible in an
   environment with no internet at all.
3. **Build where the registry lives.** The promote step is the only part that
   needs credentials. Running build+promote on an internal runner keeps the
   digest and the artifact on the same side of the boundary.
4. **Keep the images' own dependencies honest.** `nixpkgs.config.allowUnfree` is
   forced `false` in `modules/base.nix`: an unfree package has to be argued for
   in a rule or an overlay, not inherited because something else enabled it.

## The honest residual

`ubuntu-vm` (and the container entries: `webtop`, `firefox`) pull images built
and published by someone else, and two of them are referenced by *tag*. That is
the status quo, not something this work fixes; `verify-catalog.mjs` warns about
them so the number is visible rather than assumed. Moving one of them to a
digest - or rebuilding it here - is a per-entry decision, and the bouwstraat is
the place that can build the replacement.

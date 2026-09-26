# bouwstraat

The build street for mytops workspace images: **gate → build → promote → pin**.

`mytops` has always launched desktop images it did not build. The bouwstraat
makes one kind of image its own: a NixOS workspace, built from source in this
repository, referenced by digest, and verified on the device against the same
register the image was built with.

```
                 ga te            build              promote            pin
bouwstraat/  ───────────▶  qcow2 + oci image ──▶ registry ──▶ digest ──▶ webui/public/catalog.json
   (nix)                    (nix build)          (skopeo,    (sha256)    (makeConfigmap bundles it)
                                                  cosign)                     │
                                                                              ▼
                                              mytops API  ──▶  DataVolume (CDI registry import) ──▶ VM
```

Nothing reaches a user until the catalog names a digest: `verify-catalog.mjs`
refuses a `vm-*` entry whose image is not `@sha256:`-pinned, and the API warns
about one at startup. A tag is a promise someone else can break.

## Commands

```sh
bouwstraat/scripts/bouwstraat.sh gate        # every host evaluates + catalog invariants
bouwstraat/scripts/bouwstraat.sh build       # qcow2 + OCI image
bouwstraat/scripts/bouwstraat.sh promote     # push, sign, print the digest
bouwstraat/scripts/bouwstraat.sh pin         # write the digest into the catalog
bouwstraat/scripts/bouwstraat.sh verify      # catalog invariants only
```

`REGISTRY`, `IMAGE_NAME`, `HOST`, `CATALOG` overrides; `NIX`, `SKOPEO`,
`COSIGN`, `NODE` point at the binaries, which is also how the tooling test
drives the whole street with stand-ins.

## What is here

| Path | What it is |
| --- | --- |
| `flake.nix` | the image, its two artifacts (`qcow2`, `ociImage`) and the consumer contract |
| `profiles/core.nix` | the mandatory tier: blocks a consumer cannot drop |
| `profiles/hardened.nix` | the opt-in tier |
| `modules/hardening.nix` | the rule register (level × compliance, tags, per-rule switches) |
| `modules/rules/*.nix` | one file per control; a check for the device, a config for the image |
| `modules/{desktop,stream,home,users,base,cloud-init,image}.nix` | the blocks |
| `modules/hosts/vm-desktop.nix` | the workspace the catalog calls `nixos-desktop` |
| `scripts/` | the street itself |
| `catalog/*.entry.json` | what `pin` writes into the catalog, minus the digest |
| `docs/` | architecture, the runbook, and the pitfalls |

## Why a VM and not a container

The container runtime already accepts any image, so a NixOS container would need
no support at all - and would still be running inside whatever base the runtime
provides. The VM runtime is where NixOS buys something: the whole guest is built
from this flake, so the kernel, the desktop and the hardening are one
reproducible artifact instead of a base image plus a Dockerfile plus a policy
document. `vm-nixos` is that runtime; the container path is untouched.

## Status

The image evaluates and the register is wired (see `docs/`). It has **not** been
booted on real hardware from this repository yet: the first `gate`, `build` and
one VM launch on a test cluster are the remaining proof, and `docs/bouwstraat.md`
says what to look at when they happen.

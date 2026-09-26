# The runbook

## Build a new workspace image

```sh
cd bouwstraat

./scripts/bouwstraat.sh gate          # refuses to go further if this fails
./scripts/bouwstraat.sh build
./scripts/bouwstraat.sh promote       # needs registry credentials
./scripts/bouwstraat.sh pin           # writes the digest into the catalog

cd ..
(cd webui && npm ci && npm run build) # regenerates the catalog ConfigMap
git add bouwstraat/flake.lock webui/public/catalog.json base/*.configmap.json base/www
git commit -m "feat(bouwstraat): ship nixos-desktop <rev>"
```

Then let Flux reconcile, or force it:

```sh
flux reconcile kustomization mytops -n flux-system --with-source
kubectl -n services rollout restart deploy/mytops-webui   # ConfigMaps do not hot-reload
```

`pin` is the step that makes the workspace launchable. Everything before it can
be run, re-run and thrown away; a build that was never pinned does not exist as
far as a user is concerned, and `verify-catalog.mjs` is what keeps that true.

## First launch on a test cluster

What to watch, in order, because each step fails differently:

1. **The catalog entry is offered.** `GET /api/catalog` includes
   `nixos-desktop` with a digest; the SPA shows the tile for a member of the
   `nixos-desktop` group.
2. **The DataVolume imports.** `kubectl -n kubevirt get dv ws-nixos-desktop-<slug>`
   goes `Pending → ImportScheduled → Succeeded`. A failure here is a registry or
   digest problem, not an image problem: the digest exists, or the launch would
   not have been offered.
3. **The VM starts and the guest boots.** `kubectl -n kubevirt get vmi` shows
   `Running`; `printableStatus` is the hypervisor's opinion, not the desktop's.
4. **The home volume is mounted before the session.**
   `kubectl -n kubevirt exec ... -- systemctl status mytops-home` — and
   `findmnt /home/user` should name the Longhorn share. This is the step whose
   failure mode is *silent*: a desktop that started before the mount writes its
   profile into the root disk and the user sees an empty desktop, not an error.
   `mytops-verify`'s `home-mounted` rule reports exactly this, and the unit now
   fails instead of logging "continuing with a local home" — both because that
   sentence was true, and because nothing else noticed it.
5. **The session is not restarting.** `systemctl show mytops-desktop -p NRestarts`
   should be 0. A session that exits and comes back looks identical from the
   outside - the stream keeps serving the last frame it saw - so the counter is
   the only cheap signal that the desktop is actually alive.
6. **The stream answers.** The API's readiness probe is a TCP connect to 8080
   and `guestStreamReady` is an HTTP GET of `/`; both are separate from "the
   guest booted".
7. **The workspace reports its own posture.**
   `mytops-verify` needs root for the full set, and the desktop user is
   deliberately not in wheel - log in on the serial console
   (`virtctl console -n kubevirt <name>`) as the break-glass admin from
   `mytops.admin`, then run it. The register report is also at
   `/etc/mytops/hardening.json`, and the result of a root run at
   `/run/mytops/hardening-result.json`.
8. **Suspend and resume.** Idle suspension halts the VM (`runStrategy: Halted`)
   and resume is a launch, not a rebuild — the home volume is not touched by
   either. A resume that loses files means the mount was not there to begin
   with, so look at step 4 rather than at suspension.

## Building where there is no KVM

`make-disk-image` boots a small VM to install the bootloader, so it needs
`/dev/kvm` (see `docs/pitfalls.md`). If your workstation is itself a VM without
nested virtualisation, `bouwstraat.sh build` will fail after building the whole
closure. Build in the cluster instead - it has KVM because KubeVirt runs there,
and it installs the disk onto the image store in the same job:

```sh
# edit REV/SHORT in bouwstraat/cluster/build-in-cluster.yaml to the revision to
# build (the one commit that is not on the workspace node's disk is the point)
kubectl apply -f bouwstraat/cluster/build-in-cluster.yaml
kubectl -n services logs -f job/bouwstraat-build | tee /tmp/bouw.log
# the interesting lines at the end:
#   installed-bytes: 4352638976
#   GOLDEN-DISK-SHA256 <64 hex>
#   GOLDEN-DISK-REV <the revision it checked out>
```

The job asks for 8Gi on the workspace node and is pinned there, so it will sit
`Pending` with `0/3 nodes are available: 1 Insufficient memory` while a workspace
is running beside it - suspend or destroy one first (`kubectl -n kubevirt get vmi`,
or stop it from the console) and it schedules. Nothing is lost: the build has not
started, and the disk is still the previous one either way.

Then pin it - with `REV`, because the revision an artifact was built from is not
necessarily your HEAD:

```sh
REV=<40 hex from GOLDEN-DISK-REV> \
  ./scripts/bouwstraat.sh pin-disk <64 hex from GOLDEN-DISK-SHA256>
(cd webui && npm run build)     # regenerate the catalog ConfigMap
git add -A && git commit -m "feat(bouwstraat): ship <rev>"
git push                        # Flux reconciles; ConfigMaps need a restart
```

No registry is involved: the disk is served from `base/mytops-images` (RWX, so a
build can install a new disk while the store keeps serving) and the entry is
pinned by checksum. `PUSH_REGISTRY=1` in the job switches the OCI path back on
for anyone whose registry is not behind a body-size cap - the forge here is, so
it is off (see `docs/pitfalls.md`).

Existing workspaces keep the disk they were imported from; to pick up a new one,
destroy and relaunch (the home volume survives both).

## Change the app set or the desktop

`modules/hosts/vm-desktop.nix` is the only file to edit: `mytops.desktop.apps`
for packages, `mytops.hardening.*` for the trade-offs. Then run the four steps
again — the new digest is the change, and the catalog records which revision
produced it.

## Roll a workspace back

Delete it and re-pin the previous digest in the catalog: workspaces are
replaced on their next launch, and a workspace's home volume outlives the
workspace on purpose (`home-<slug>`, untouched by teardown), so rolling back
costs the user nothing but a restart.

```sh
# find the previous pinned revision
git log -p -- webui/public/catalog.json | grep -E '^[+-].*desktop-nixos@sha256'
```

## Turn a rule off for one host

```nix
mytops.hardening.rules."usbguard" = false;
```

State the reason in a comment next to it. The register already records *that* a
rule is off (`/etc/mytops/hardening.json`, and the `off:` line in
`mytops-verify`); the reason is the part only a human can leave behind.

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
5. **The stream answers.** The API's readiness probe is a TCP connect to 8080
   and `guestStreamReady` is an HTTP GET of `/`; both are separate from "the
   guest booted".
6. **The workspace reports its own posture.**
   `deploy@<namespace> exec ... mytops-verify` (as root for the full set). The
   register report is also at `/etc/mytops/hardening.json`, and the result of a
   root run at `/run/mytops/hardening-result.json`.
7. **Suspend and resume.** Idle suspension halts the VM (`runStrategy: Halted`)
   and resume is a launch, not a rebuild — the home volume is not touched by
   either. A resume that loses files means the mount was not there to begin
   with, so look at step 4 rather than at suspension.

## Building where there is no KVM

`make-disk-image` boots a small VM to install the bootloader, so it needs
`/dev/kvm` (see `docs/pitfalls.md`). If your workstation is itself a VM without
nested virtualisation, `bouwstraat.sh build` will fail after building the whole
closure. Build in the cluster instead - it has KVM because KubeVirt runs there:

```sh
# one-off, not managed by Flux: it is a build, not a desired state
kubectl -n services create secret docker-registry forgejo-registry \
  --docker-server=forge.tuntelder.com --docker-username=<user> \
  --docker-password=<token>
kubectl apply -f bouwstraat/cluster/build-in-cluster.yaml
kubectl -n services logs -f job/bouwstraat-build | tee /tmp/bouw.log
# the last line is BOUWSTRAAT-IMAGE <registry>/<image>@sha256:<digest>
```

Then pin that digest, which is the same step as always:

```sh
./scripts/bouwstraat.sh pin sha256:<digest> forge.tuntelder.com/mtuntelder/mytops-desktop-nixos
```

Edit `REV`/`SHORT` in the Job's env before running it for a new revision; the
Job prints the digest it read back from the registry, never the one it assumed.

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

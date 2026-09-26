# mytops

Browser workspace launcher behind `https://apps.<cluster-domain>`: an nginx-served
Vite/React SPA plus a small workplace API. The API validates requests server-side,
enforces the catalog entry's group ACL, and provisions per-user workspace
Deployments, Services and IngressRoutes through a `kubectl proxy` sidecar that is
scoped to its own ServiceAccount and bound to the pod's loopback.

The cluster that runs this app is **[nebula](https://github.com/Myrenic/nebula)**.
Everything that is platform rather than app lives there: Traefik, Keycloak +
oauth2-proxy, Longhorn, cert-manager, the `apps.<domain>` IngressRoute, the
`cluster-secrets` SOPS bundle, and the cross-namespace RBAC grants listed below.

## Layout

| Path | What |
| --- | --- |
| `webui/` | Vite + React SPA source; builds into `base/www` |
| `webui/public/catalog.json` | the catalog: the one list of launchable desktops/apps |
| `api/` | workplace API (`server.mjs`), shipped to the cluster as a ConfigMap |
| `bouwstraat/` | the NixOS workspace image: flake, hardening register, and the gate/build/promote/pin street |
| `base/` | Kubernetes manifests - this is what nebula deploys |
| `base/www/` | built SPA assets (committed on purpose) |
| `base/*.configmap.json` | generated ConfigMap bundles (committed on purpose) |

## Build

```bash
# SPA + the webui/workplace-api/catalog ConfigMap bundles
cd webui && npm ci && npm run build && cd ..

# manifest check
kubectl kustomize . >/dev/null
```

`npm run build` runs `tsc -b`, vite, and `webui/scripts/build-configmap.mjs`, which
regenerates `base/www`, `base/mytops-webui.configmap.json`,
`base/mytops-workplace-api.configmap.json` and
`base/mytops-api-catalog.configmap.json` (the last one generated from
`webui/public/catalog.json`, so the list the API validates against cannot drift
from the one the SPA ships). The build is byte-reproducible, which is what CI
checks: build, then `git diff --exit-code`. If you change `webui/` or
`api/server.mjs` and the diff is not empty, you forgot to commit the regenerated
bundles - ConfigMaps do not hot-reload, so a stale bundle silently keeps running.

The build also fails if `api/server.mjs` contains a dollar-brace or dollar-name
sequence, because that ConfigMap is plain `data` and Flux's postBuild envsubst
would rewrite the running API's source (see the idle-culler ConfigMap for the
same trap, which is stored base64 for exactly this reason).

`npm run lint` currently reports two pre-existing `react-refresh/only-export-components`
errors; it is deliberately not part of the gate.

## NixOS workspaces (`bouwstraat/`)

A second VM guest besides `ubuntu-vm`: `runtime: vm-nixos` boots a disk this
repository builds, not a stock cloud image. Everything that makes the desktop -
kernel, XFCE, Xvfb/x11vnc/noVNC, the hardening - is one flake built from a pinned
nixpkgs revision, and the catalog references it by **digest**:

```json
"runtime": "vm-nixos",
"image": "registry.example/mytops/desktop-nixos@sha256:...",
"source": { "flake": "bouwstraat#nixosConfigurations.mytops-vm-desktop", "rev": "<40 hex>" }
```

The API needs almost nothing new for this: `vmDiskSource(entry)` imports from a
registry (CDI) when the entry carries an image and falls back to the public cloud
image when it does not, and `cloudInitUserData` sends a NixOS guest its home
volume instead of an apt/docker bootstrap. Service, IngressRoute, readiness probe
and status derivation are unchanged - a NixOS workspace answers on 8080 like
every other VM.

Build and pin one:

```bash
bouwstraat/scripts/bouwstraat.sh gate     # every host evaluates + catalog invariants
bouwstraat/scripts/bouwstraat.sh build
bouwstraat/scripts/bouwstraat.sh promote  # push + sign, prints the digest
bouwstraat/scripts/bouwstraat.sh pin      # writes image@digest + source.rev into the catalog
(cd webui && npm run build)               # regenerate the catalog ConfigMap
```

`pin` is what makes the entry launchable. `verify-catalog.mjs` refuses a `vm-*`
entry whose image is not `@sha256:`-pinned, and `build-configmap.mjs` refuses to
ship one - a tag is a reference somebody else can repoint, and this is the one
place where that decides what code runs on a user's desktop. See
`bouwstraat/docs/` for the architecture, the runbook and the pitfalls.

## Deploy

Flux in nebula reconciles this repository:

```
nebula/kubernetes/apps/services/mytops/source.yaml  -> GitRepository (this repo, branch main)
nebula/kubernetes/apps/services/mytops/ks.yaml      -> Kustomization, path ./base,
                                                       targetNamespace: services,
                                                       postBuild.substituteFrom: cluster-secrets
```

Push here, then either wait for the 1 minute poll or force it:

```bash
flux reconcile kustomization mytops -n flux-system --with-source
kubectl -n services rollout status deploy/mytops-webui --timeout=180s
```

ConfigMap changes do not restart pods. After a bundle change:

```bash
kubectl -n services rollout restart deploy/mytops-webui
```

## Secrets

No secret is stored in this repository. `base/mytops-turn.yaml` is a Secret whose
values are `${...}` placeholders that nebula substitutes from its
`cluster-secrets` SOPS bundle at build time:

| Placeholder | Where the value lives |
| --- | --- |
| `TURN_SHARED_SECRET` | `nebula/kubernetes/apps/common/cluster-secrets.sops.yaml` |
| `SECRET_DOMAIN_0` (`BASE_DOMAIN` in `base/webui.yaml`) | same bundle |

Rotating the TURN shared secret therefore happens in nebula; the pods here read it
from the environment, so rotation needs a restart:

```bash
kubectl -n services rollout restart deploy/mytops-coturn deploy/mytops-webui
```

Two things to know about that placeholder: Flux substitutes into the built YAML
*before* it is parsed and kustomize drops the quotes around a placeholder that is a
whole scalar, so a numeric-looking value is applied as an integer and the API server
rejects the Secret (`stringData.TURN_PORT: expected string, got 3478`). Settings that
look numeric (`TURN_PORT`) are literals in `base/mytops-turn.yaml` for that reason, and
the secret itself is generated as hex (`openssl rand -hex 32`) so it can never be
all-digits.

## Cross-namespace RBAC lives in nebula

This Kustomization forces `targetNamespace: services`, which overrides any explicit
`namespace:` in a manifest here. Grants that belong in other namespaces are therefore
platform files in nebula:

| Grant | File |
| --- | --- |
| create/delete IngressRoutes in `network` | `nebula/kubernetes/apps/mytops-control/network.yaml` |
| delete `volumes.longhorn.io` in `storage` (VM disk teardown) | `nebula/kubernetes/apps/mytops-control/storage.yaml` |
| VirtualMachines, DataVolumes and their Secrets/Services/PVCs in `kubevirt` | `nebula/kubernetes/apps/mytops-control/kubevirt.yaml` |

All three live in one directory in nebula (`kubernetes/apps/mytops-control/`, applied
without a `targetNamespace`) so that one place answers what this API may do.

Two consequences for the API code, both of which it has to respect:

- The network Role grants `get/list/create/delete` on IngressRoutes and **no
  `update`**, so repairing a drifted route is delete-then-create. A `PUT` is
  answered with 403.
- The Longhorn CRs live in the `storage` namespace (whatever the operator's
  HelmRelease namespace happens to be), which is why `LONGHORN_NAMESPACE` is
  `storage` in `base/webui.yaml` and not the upstream default `longhorn-system`.

## Operating notes

- The `kubectl-proxy` sidecar listens on `127.0.0.1:8001` - loopback only, because the
  workplace API container shares the pod's network namespace. Do not move it to
  `0.0.0.0`: its ServiceAccount can create and delete workspace Deployments,
  IngressRoutes and Longhorn volumes.
- A NetworkPolicy in `base/` allows ingress to the webui pod from the `network`
  namespace (Traefik) only.
- The API answers 401 without an `X-Auth-Request-Email` header (only `/api/health`,
  which the readiness probe uses, is open). Identity comes from oauth2-proxy, which
  strips any client-supplied `X-Auth-Request-*` before injecting its own.
- `mytops-idle-culler` deletes **container** sessions whose `mytops-lifecycle` label is
  `ephemeral`/`disposable` and that are older than `MAX_LIFETIME_MINUTES` (480).
  `suspend` and `persistent` sessions are never culled: the job has no idle signal,
  only creation age. It has no opinion about VM workspaces at all - an entry with
  `runtime: vm-*` and a cullable lifecycle would leak its disk, so either keep VM
  entries `suspend`/`persistent` (as `ubuntu-vm` is) or extend the script first.
- Workspace status is derived from the pod: `readyReplicas` (behind a TCP readiness
  probe on the desktop's port, so "Running" means the web client answers), a
  crash-looping container, or the VM's `printableStatus`. A workspace that cannot come
  up reports `offline`, which is what gives the UI its Restart button instead of an
  endless "Starting".
- Launch and restart answer as soon as the objects are created/patched and let the
  SPA's 5 s poll report the outcome; nothing in the API blocks for minutes while a pod
  pulls an image.
- **The user's data lives in a per-user home volume, not in a workspace.**
  `home-<slug>` is a ReadWriteMany Longhorn PVC in `services` holding the
  desktop profile (what linuxserver images call `/config`). A container
  workspace mounts the PVC; a VM cannot (a VMI may only reference a PVC from its
  own namespace), so the guest mounts the same volume over NFS instead. That
  export is the share-manager Service in `storage`, named after the
  PersistentVolume (`<pv>.<storage-ns>.svc.cluster.local:/<pv>`), which only
  exists while the volume is attached - hence `home-<slug>-keeper`, a pod whose
  whole job is to hold it attached for the VM case.
  Consequences worth knowing: destroying a workspace never deletes the home
  (that is what makes a VM rebuildable from scratch without losing work), a
  persistent entry rolls with `strategy: Recreate` so two desktops never write
  one profile at once - and the home is per *user*, so two *different*
  persistent entries running at the same time (say a container desktop and a VM
  desktop) do write one profile; the catalog has one of each today, and each is
  a full desktop, so treat that as a thing to avoid rather than a feature.
  Deleting the home is a deliberate manual act
  (`kubectl -n services delete deploy home-<slug>-keeper pvc home-<slug>` plus
  the PV/Longhorn volume behind it).
- **Streams are owner-scoped.** Workspace IngressRoutes carry two middlewares:
  `oauth2-proxy-auth` (the existing chain) and `mytops-workspace-owner`, a
  forwardAuth declared in nebula that asks `GET /api/stream-auth` whether the
  signed-in user owns the host in the request. Authentication alone used to be
  the whole gate, and a workspace host is derived from its owner's email, so
  any user in the realm could open anyone's desktop. The endpoint trusts only
  identity resolved from oauth2-proxy's own headers or from its session cookie -
  never a client-supplied header - and admins pass.
- **Files are reachable without a session.** Each user's keeper pod runs the
  home agent (`api/home-agent.mjs`, `mytops-home-agent` ConfigMap): it mounts
  only that user's volume and serves list/read/write/mkdir/move/delete over
  HTTP. It has no Service and no DNS name - the workplace API resolves the pod
  by label and proxies to its IP, after mapping the caller to a user, and a
  NetworkPolicy admits the webui pod alone. uploads and downloads stream
  through; paths are normalised into the volume and symlinks out of it are
  refused. Admins can pass `?owner=<slug>` (audited, and the UI keeps it
  read-only). The agent runs as root for one reason: a brand-new Longhorn
  volume is root-owned and every desktop in this system is uid 1000, so it
  hands the root over on first start. It mounts nothing else, takes no service
  account token, drops all capabilities and runs with a read-only root
  filesystem.
- **Admins have a page.** `/api/admin/workspaces` (list, everyone's), the
  `suspend`/`resume` actions and the destroy endpoint all sit behind
  `ADMIN_GROUPS` (`admin,admins` by default) from the oauth2-proxy group header,
  and `/api/me` reports `isAdmin` only so the SPA can show the tab - every admin
  route re-checks it. The page is deliberately blunt about what it does: rows
  name the owner and their home volume, and destroying someone's workspace says
  their files are kept (the teardown cannot reach `home-*`).
  Every state change writes one `audit: {...}` line to stdout (`actor`, `action`,
  `target`), including the idle sweep's suspensions and denied stream attempts -
  the cluster's log stack is the store, because an audit trail that can fail to
  write is worse than none.
- **Idle workspaces are stopped, not destroyed.** An entry can say how long it
  may sit unused (`idleSuspendMinutes` in `catalog.json`); the API then stops it
  in place - `spec.replicas: 0` for a container, `runStrategy: Halted` for a VM -
  and marks it with `mytops/suspended-at`. The home volume is untouched, so
  "Resume" is a launch, not a rebuild. Activity means the SPA had the workspace
  on screen (it heartbeats `/api/workspaces/:id/touch` every 30s while the tab
  is visible and the document is not hidden) or a stream was opened for it
  (`/api/stream-auth` counts). A sweep every minute compares each workspace's
  last activity against its entry's policy; the last value also lands on the
  workspace as the `mytops/last-active` annotation, so a restart of the API can
  only make it slower to suspend, never suspend something in use. Entries
  without the field are never suspended - a compute job you leave running is not
  "idle" just because nobody is looking at it.
- The idle sweep is off when `IDLE_CHECK_MS=0` (the test harness runs it at
  300ms with a fractional policy to exercise the decision).

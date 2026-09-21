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
| create/delete IngressRoutes in `network` | `nebula/kubernetes/apps/network/ingressroutes/control.yaml` |
| delete `volumes.longhorn.io` in `storage` (VM disk teardown) | `nebula/kubernetes/apps/storage/mytops-rbac.yaml` |

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
- coturn runs `hostNetwork` on `TURN_HOST` and relays UDP `61000-65535`; WebRTC media
  from the browser goes straight to it, not through the ingress. The API maps the
  `mytops-turn` Secret's `TURN_*` variables onto `SELKIES_TURN_*` for both kinds of
  workspace. A VM bakes that config into its cloud-init Secret at creation time, so
  rotating the shared secret only reaches an existing VM after it is destroyed and
  relaunched.
- Container workspaces keep their desktop state in the pod: the Deployment has no
  `/config` volume, so a `persistence: persistent` container entry survives a
  restart of the *pod schedule* but not a reschedule, eviction or destroy. Only VM
  workspaces carry their `/config` on the Longhorn disk. Adding the volume is a
  deliberate change, not an oversight - it needs a PVC per user plus the PVC verbs in
  the services-namespace Role, and the culler would have to clean it up.
- Whoever can authenticate to the realm can open any workspace URL: the per-workspace
  IngressRoutes carry the `oauth2-proxy-auth` middleware, which authenticates but does
  not authorize, and the instance name in the host is derived from the owner's email.
  Scoping a route to its owner needs a platform-side forward-auth (a Middleware that
  asks the API whether the email in the request owns the host in the request).

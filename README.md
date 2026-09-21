# shacdn

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
| `api/` | workplace API (`server.mjs`), shipped to the cluster as a ConfigMap |
| `base/` | Kubernetes manifests - this is what nebula deploys |
| `base/www/` | built SPA assets (committed on purpose) |
| `base/*.configmap.json` | generated ConfigMap bundles (committed on purpose) |

## Build

```bash
# SPA + the webui/workplace-api ConfigMap bundles
cd webui && npm ci && npm run build && cd ..

# manifest check
kubectl kustomize . >/dev/null
```

`npm run build` runs `tsc -b`, vite, and `webui/scripts/build-configmap.mjs`, which
regenerates `base/www`, `base/shacdn-webui.configmap.json` and
`base/shacdn-workplace-api.configmap.json`. The build is byte-reproducible, which is
what CI checks: build, then `git diff --exit-code`. If you change `webui/` or
`api/server.mjs` and the diff is not empty, you forgot to commit the regenerated
bundles - ConfigMaps do not hot-reload, so a stale bundle silently keeps running.

`npm run lint` currently reports two pre-existing `react-refresh/only-export-components`
errors; it is deliberately not part of the gate.

## Deploy

Flux in nebula reconciles this repository:

```
nebula/kubernetes/apps/services/shacdn/source.yaml  -> GitRepository (this repo, branch main)
nebula/kubernetes/apps/services/shacdn/ks.yaml      -> Kustomization, path ./base,
                                                       targetNamespace: services,
                                                       postBuild.substituteFrom: cluster-secrets
```

Push here, then either wait for the 1 minute poll or force it:

```bash
flux reconcile kustomization shacdn -n flux-system --with-source
kubectl -n services rollout status deploy/shacdn-webui --timeout=180s
```

ConfigMap changes do not restart pods. After a bundle change:

```bash
kubectl -n services rollout restart deploy/shacdn-webui
```

## Secrets

No secret is stored in this repository. `base/shacdn-turn.yaml` is a Secret whose
values are `${...}` placeholders that nebula substitutes from its
`cluster-secrets` SOPS bundle at build time:

| Placeholder | Where the value lives |
| --- | --- |
| `TURN_SHARED_SECRET` | `nebula/kubernetes/apps/common/cluster-secrets.sops.yaml` |

Rotating the TURN shared secret therefore happens in nebula; the pods here read it
from the environment, so rotation needs a restart:

```bash
kubectl -n services rollout restart deploy/shacdn-coturn deploy/shacdn-webui
```

Two things to know about that placeholder: Flux substitutes into the built YAML
*before* it is parsed and kustomize drops the quotes around a placeholder that is a
whole scalar, so a numeric-looking value is applied as an integer and the API server
rejects the Secret (`stringData.TURN_PORT: expected string, got 3478`). Settings that
look numeric (`TURN_PORT`) are literals in `base/shacdn-turn.yaml` for that reason, and
the secret itself is generated as hex (`openssl rand -hex 32`) so it can never be
all-digits.

## Cross-namespace RBAC lives in nebula

This Kustomization forces `targetNamespace: services`, which overrides any explicit
`namespace:` in a manifest here. Grants that belong in other namespaces are therefore
platform files in nebula:

| Grant | File |
| --- | --- |
| create/delete IngressRoutes in `network` | `nebula/kubernetes/apps/network/ingressroutes/control.yaml` |
| delete `volumes.longhorn.io` in `storage` (VM disk teardown) | `nebula/kubernetes/apps/storage/shacdn-rbac.yaml` |

## Operating notes

- The `kubectl-proxy` sidecar listens on `127.0.0.1:8001` - loopback only, because the
  workplace API container shares the pod's network namespace. Do not move it to
  `0.0.0.0`: its ServiceAccount can create and delete workspace Deployments,
  IngressRoutes and Longhorn volumes.
- A NetworkPolicy in `base/` allows ingress to the webui pod from the `network`
  namespace (Traefik) only.
- `shacdn-idle-culler` deletes sessions whose `shacdn-lifecycle` label is
  `ephemeral`/`disposable` and that are older than `MAX_LIFETIME_MINUTES` (480).
  `suspend` and `persistent` sessions are never culled: the job has no idle signal,
  only creation age.
- coturn runs `hostNetwork` on `TURN_HOST` and relays UDP `61000-65535`; WebRTC media
  from the browser goes straight to it, not through the ingress.

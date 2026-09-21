# mytops-webui

The mytops launcher web UI — a [shadcn/ui](https://ui.shadcn.com/) (Radix)
React app that lists the available cloud desktops/apps from the catalog the
workplace API serves.

Workspaces are **embedded in the page** (iframe, not a new tab): connecting to
an entry opens it under a top tab bar, and you can open several and switch
between them from the tabs. Only the active workspace is mounted, so the
stream stops on switch (the desktop pod keeps running and reconnects when you
switch back). The desktops run in **Wayland mode** (`PIXELFLUX_WAYLAND=true`,
labwc + panel).

The iframe is remounted whenever the workspace's health changes (starting /
running / offline). A workspace can only be framed once it answers, so without
that the frame would hold Traefik's 502 page forever.

## How the deploy works

The cluster has no container registry or in-cluster build, so the built static
bundle is committed and served from a ConfigMap:

1. `npm run build` — TypeScript check + Vite build into `../base/www/` (flat,
   deterministic `index.html`/`index.js`/`index.css` so ConfigMap keys are
   stable), then regenerates `../base/mytops-webui.configmap.json`,
   `../base/mytops-workplace-api.configmap.json` and
   `../base/mytops-api-catalog.configmap.json`.
2. `index.js`/`index.css`/`me` are stored as `binaryData` (base64): the minified
   JS contains raw control characters the kustomize/YAML emitter cannot write as
   text data. `index.html` stays as plain `data`.
3. Flux kustomization `kubernetes/apps/services/mytops/base` mounts that
   ConfigMap into the `nginx` deployment.

## Adding an app/desktop to the catalog

Edit `public/catalog.json`, then run `npm run build` and commit
`public/catalog.json`, the rebuilt `base/www/` files, and the regenerated
`base/*.configmap.json` bundles. That file is the single source of truth: the
build turns it into the API's catalog ConfigMap, and the API is what serves the
catalog to this SPA and validates every launch against it.

An entry needs `id`, `name`, `type` (`desktop`/`app`), an optional
`icon`/`description`, and for containers an `image`. Optional: `runtime`
(`container` or `vm-linux`/`vm-windows`), `persistence`, `lifecycle`,
`resources` (`cpu`/`memory`), `storage` (VM root disk size), `homeStorage`
(size of the user's home volume), `idleSuspendMinutes` (stop it when it sits
unused, see below) and `env`. An entry with no `groups` is
visible to everyone signed in; otherwise the launch is gated on one of those
Keycloak groups.

### Persistence and the home volume

`persistence: persistent` entries mount the user's home volume at `/config` (or
the VM equivalent, see below); `disposable` ones do not, so a throwaway session
never holds - or writes to - a profile.

There is one home volume per *user* (`home-<slug>`, ReadWriteMany, 20Gi by
default), not per entry, so the same desktop reaches a user from either kind of
workspace: a container workspace mounts the PVC directly, and a VM's guest
mounts the same volume over NFS. Destroying a workspace keeps the home volume -
that is the point of it - so a `storage`/`homeStorage` bump is the only place
sizes appear, and clearing a user's data is a deliberate manual act.

### Idle suspension

`idleSuspendMinutes` is how long a workspace may sit unused before the API stops
it - `replicas: 0` for a container, `runStrategy: Halted` for a VM - leaving the
home volume alone, so Resume is a launch and not a rebuild. The SPA heartbeats
the workspace it has on screen (every 30s, only while the tab is visible) and
opening a stream counts too. Entries without the field are never suspended:
something you leave computing is not idle just because nobody is watching it.
The catalog sets 60 minutes for the desktops and 30 for the throwaway browser.

## Local dev

```bash
npm install
npm run dev        # http://localhost:5173, /api proxied to :3001
node ../api/server.mjs   # the workplace API the SPA talks to
```

`npm run dev` proxies `/api` to `http://127.0.0.1:3001` (override with
`API_PROXY`). Without a running API every `/api` request falls through to
`index.html` and the app reports that you are not signed in. In dev the API sees
no `X-Auth-Request-Email` and answers 401, so set a header yourself (e.g. point
`API_PROXY` at a proxy that injects one, the way oauth2-proxy does in the
cluster).

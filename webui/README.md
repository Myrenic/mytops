# chacdn-webui

The ChACDN launcher web UI — a [shadcn/ui](https://ui.shadcn.com/) (Radix)
React app that lists the available cloud desktops/apps from `catalog.json`.

Workspaces are **embedded in the page** (iframe, not a new tab): connecting to
an entry opens it under a top tab bar, and you can open several and switch
between them from the tabs. Only the active workspace is mounted, so the
Selkies stream stops on switch (the desktop pod keeps running and reconnects
when you switch back). The Selkies desktops run in **Wayland mode**
(`PIXELFLUX_WAYLAND=true`, labwc + panel).

## How the deploy works

The cluster has no container registry or in-cluster build, so the built static
bundle is committed and served from a ConfigMap:

1. `npm run build` — TypeScript check + Vite build into `../base/www/` (flat,
   deterministic `index.html`/`index.js`/`index.css` so ConfigMap keys are
   stable), then regenerates `../base/chacdn-webui.configmap.json`.
2. `index.js`/`index.css` are stored as `binaryData` (base64): the minified JS
   contains raw control characters the kustomize/YAML emitter cannot write as
   text data. `index.html`/`catalog.json` stay as plain `data` so Flux
   postBuild can still expand `${SECRET_DOMAIN_0}` in `catalog.json`.
3. Flux kustomization `kubernetes/apps/services/chacdn/base` mounts that
   ConfigMap into the `nginx` deployment.

## Adding an app/desktop to the catalog

Edit `public/catalog.json`, then run `npm run build` and commit
`public/catalog.json`, the rebuilt `base/www/` files, and
`base/chacdn-webui.configmap.json`. The entry just needs `id`, `name`, `url`,
`type` (`desktop`/`app`) and an optional `icon`/`description`.

## Local dev

```bash
npm install
npm run dev        # http://localhost:5173
```

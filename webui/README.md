# chacdn-webui

The ChACDN launcher web UI — a [shadcn/ui](https://ui.shadcn.com/) (Radix)
React app listing the available cloud desktops/apps from `catalog.json` with a
search + type filter, and a "Connect" link per entry that opens the Selkies
session.

## How the deploy works

The cluster has no container registry or in-cluster build, so the built static
bundle is committed and served from a ConfigMap:

1. `npm run build` — TypeScript check + Vite build into `../base/www/` (flat,
   deterministic `index.html`/`index.js`/`index.css` so ConfigMap keys are
   stable), then regenerates `../base/chacdn-webui.configmap.json`.
2. Files are stored in the ConfigMap as `binaryData` (base64): the minified JS
   contains raw control characters that the kustomize/YAML emitter cannot
   write as text data.
3. Flux kustomization `kubernetes/apps/services/chacdn/base` mounts that
   ConfigMap into the `nginx` deployment and Flux substitutes
   `${SECRET_DOMAIN_0}` inside `catalog.json` at apply time.

## Adding an app/desktop to the catalog

Edit `public/catalog.json`, then run `npm run build` and commit
`public/catalog.json`, the rebuilt `base/www/` files, and
`base/chacdn-webui.configmap.json`.

## Local dev

```bash
npm install
npm run dev        # http://localhost:5173
```

// Regenerates base/chacdn-webui.configmap.json from the vite output in
// base/www, and base/chacdn-workplace-api.configmap.json from api/server.mjs.
// The minified JS/CSS are stored as binaryData (base64) because they contain
// raw control characters that the kustomize/yaml emitter refuses to write as
// text data. index.html and catalog.json stay as plain data so Flux postBuild
// substitution can still expand ${SECRET_DOMAIN_0} inside catalog.json (base64
// content is opaque to it).
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const base = resolve(import.meta.dirname, "../../base")
const www = join(base, "www")

// ── SPA assets ConfigMap ──────────────────────────────────────────────
const spaOut = join(base, "chacdn-webui.configmap.json")
const files = (await readdir(www)).filter((f) => !f.startsWith("."))
const binaryData = {}
const data = {}
for (const f of files) {
  const content = await readFile(join(www, f))
  if (f === "index.html" || f === "catalog.json") {
    data[f] = content.toString("utf8")
  } else {
    binaryData[f] = content.toString("base64")
  }
}

const spaConfigMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "chacdn-webui" },
  ...(Object.keys(data).length ? { data } : {}),
  ...(Object.keys(binaryData).length ? { binaryData } : {}),
}

await writeFile(spaOut, JSON.stringify(spaConfigMap, null, 2) + "\n")
console.log(
  `wrote ${spaOut} (${files.length} files, ${Math.round(
    Buffer.byteLength(await readFile(spaOut)) / 1024
  )} KiB)`
)

// ── Workplace API ConfigMap (single source of truth: api/server.mjs) ──
const serverSrc = resolve(import.meta.dirname, "../../api/server.mjs")
const apiOut = join(base, "chacdn-workplace-api.configmap.json")
const serverCode = await readFile(serverSrc, "utf8")

const apiConfigMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "chacdn-workplace-api" },
  data: { "server.mjs": serverCode },
}

await writeFile(apiOut, JSON.stringify(apiConfigMap, null, 2) + "\n")
console.log(
  `wrote ${apiOut} (server.mjs, ${Math.round(
    Buffer.byteLength(serverCode) / 1024
  )} KiB)`
)

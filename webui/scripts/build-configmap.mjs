// Regenerates base/mytops-webui.configmap.json from the vite output in
// base/www, base/mytops-workplace-api.configmap.json from api/server.mjs, and
// base/mytops-api-catalog.configmap.json from webui/public/catalog.json.
// The minified JS/CSS are stored as binaryData (base64) because they contain
// raw control characters that the kustomize/yaml emitter refuses to write as
// text data.
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const base = resolve(import.meta.dirname, "../../base")
const www = join(base, "www")

// ── SPA assets ConfigMap ──────────────────────────────────────────────
const spaOut = join(base, "mytops-webui.configmap.json")
const files = (await readdir(www)).filter((f) => !f.startsWith("."))
const binaryData = {}
const data = {}
for (const f of files) {
  const content = await readFile(join(www, f))
  if (f === "index.html") {
    data[f] = content.toString("utf8")
  } else {
    binaryData[f] = content.toString("base64")
  }
}

const spaConfigMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "mytops-webui" },
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
const apiOut = join(base, "mytops-workplace-api.configmap.json")
const serverCode = await readFile(serverSrc, "utf8")

// The API ConfigMap is plain (non-base64) data, so Flux postBuild runs
// envsubst over it and replaces every $VAR / ${VAR} it finds - with an empty
// string when the name is unknown, or with a cluster secret's value when it is
// not. Either way that would rewrite the running API's source. Fail the build
// rather than ship it.
const placeholders = serverCode.match(/\$[A-Za-z_{]/g)
if (placeholders) {
  throw new Error(
    `api/server.mjs contains ${placeholders.length} dollar-variable sequence(s) ` +
      `(${placeholders.slice(0, 5).join(", ")}); Flux postBuild would substitute ` +
      `them inside the mytops-workplace-api ConfigMap. Build the string with ` +
      `concatenation instead (this includes comments).`
  )
}

const apiConfigMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "mytops-workplace-api" },
  data: { "server.mjs": serverCode },
}

await writeFile(apiOut, JSON.stringify(apiConfigMap, null, 2) + "\n")
console.log(
  `wrote ${apiOut} (server.mjs, ${Math.round(
    Buffer.byteLength(serverCode) / 1024
  )} KiB)`
)

// ── Idle-culler ConfigMap (single source of truth: base/cull.sh) ──────
// The script has to be base64 (plain ConfigMap data is envsubst'd by Flux
// postBuild, which eats its shell variables), but it must stay reviewable: as a
// stored blob nobody could grep it, and a label rename left it culling nothing
// for weeks. Source text here, encoding at build time.
const cullSrc = join(base, "cull.sh")
const cullScript = await readFile(cullSrc, "utf8")

// The culler selects workspaces by these labels; if either side of the contract
// renames one, the job goes quiet instead of failing. Catch it here.
for (const label of ["mytops-owner", "mytops-lifecycle", "mytops-runtime"]) {
  if (!cullScript.includes(label) || !serverCode.includes(label)) {
    throw new Error(
      `${label} is missing from ${!cullScript.includes(label) ? "base/cull.sh" : "api/server.mjs"}; ` +
        `the idle culler and the API must agree on workspace labels`
    )
  }
}

const cullOut = join(base, "mytops-idle-culler.configmap.json")
const cullConfigMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "mytops-idle-culler-script" },
  binaryData: { "cull.sh": Buffer.from(cullScript).toString("base64") },
}

await writeFile(cullOut, JSON.stringify(cullConfigMap, null, 2) + "\n")
console.log(`wrote ${cullOut} (cull.sh, ${Buffer.byteLength(cullScript)} bytes)`)

// ── Home agent ConfigMap (single source of truth: api/home-agent.mjs) ──
// Mounted into the per-user keeper pod, which is the only thing serving a
// user's home volume to the file API.
const agentSrc = resolve(import.meta.dirname, "../../api/home-agent.mjs")
const agentCode = await readFile(agentSrc, "utf8")
const agentOut = join(base, "mytops-home-agent.configmap.json")
const agentConfigMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "mytops-home-agent" },
  data: { "home-agent.mjs": agentCode },
}
await writeFile(agentOut, JSON.stringify(agentConfigMap, null, 2) + "\n")
console.log(`wrote ${agentOut} (home-agent.mjs, ${Math.round(Buffer.byteLength(agentCode) / 1024)} KiB)`)

// ── Catalog ConfigMap (single source of truth: public/catalog.json) ───
// The API validates every launch against this catalog (including the group
// ACL) and serves it to the SPA, so it has to be the same list the SPA ships.
// Generating it here means the two can no longer drift: an entry added to
// public/catalog.json reaches the API, which is the only thing that reads it.
const catalogSrc = join(resolve(import.meta.dirname, ".."), "public", "catalog.json")
const catalogRaw = await readFile(catalogSrc, "utf8")
const catalog = JSON.parse(catalogRaw)
const ids = catalog.apps.map((entry) => entry.id)
const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
if (duplicate) {
  throw new Error(`public/catalog.json has a duplicate entry id: ${duplicate}`)
}

const catalogOut = join(base, "mytops-api-catalog.configmap.json")
const catalogConfigMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "mytops-api-catalog" },
  data: { "catalog.json": JSON.stringify(catalog, null, 2) },
}

await writeFile(catalogOut, JSON.stringify(catalogConfigMap, null, 2) + "\n")
console.log(`wrote ${catalogOut} (${ids.length} catalog entries)`)


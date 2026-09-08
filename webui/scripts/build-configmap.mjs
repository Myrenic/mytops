// Regenerates base/chacdn-webui.configmap.json from the vite output in
// base/www. The minified JS/CSS are stored as binaryData (base64) because
// they contain raw control characters that the kustomize/yaml emitter
// refuses to write as text data. index.html and catalog.json stay as plain
// data so Flux postBuild substitution can still expand ${SECRET_DOMAIN_0}
// inside catalog.json (base64 content is opaque to it).
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const www = resolve(import.meta.dirname, "../../base/www")
const out = resolve(import.meta.dirname, "../../base/chacdn-webui.configmap.json")

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

const configMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "chacdn-webui" },
  ...(Object.keys(data).length ? { data } : {}),
  ...(Object.keys(binaryData).length ? { binaryData } : {}),
}

await writeFile(out, JSON.stringify(configMap, null, 2) + "\n")
console.log(
  `wrote ${out} (${files.length} files, ${Math.round(
    Buffer.byteLength(await readFile(out)) / 1024
  )} KiB)`
)

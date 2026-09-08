// Regenerates base/chacdn-webui.configmap.json from the vite output in
// base/www. Files are stored as binaryData (base64) because the minified
// bundle contains raw control characters that the kustomize/yaml emitter
// refuses to write as text data.
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const www = resolve(import.meta.dirname, "../../base/www")
const out = resolve(import.meta.dirname, "../../base/chacdn-webui.configmap.json")

const files = (await readdir(www)).filter((f) => !f.startsWith("."))
const binaryData = {}
for (const f of files) {
  binaryData[f] = (await readFile(join(www, f))).toString("base64")
}

const configMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "chacdn-webui" },
  binaryData,
}

await writeFile(out, JSON.stringify(configMap, null, 2) + "\n")
console.log(
  `wrote ${out} (${files.length} files, ${Math.round(
    Buffer.byteLength(await readFile(out)) / 1024
  )} KiB base64)`
)

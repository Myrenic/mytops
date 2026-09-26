#!/usr/bin/env node
// Write a promoted image digest into the mytops catalog.
//
// This is the only step that makes a bouwstraat build reachable: the catalog is
// what the API reads, and an entry without a digest is refused by
// verify-catalog.mjs, so an image that was built but not pinned does not exist
// as far as a user is concerned. That is deliberate - the alternative is a
// workspace that runs whatever a tag points at today.
import { readFile, writeFile } from "node:fs/promises"

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!key.startsWith("--")) throw new Error("unexpected argument: " + key)
  args.set(key.slice(2), process.argv[i + 1])
}

function required(name) {
  const value = args.get(name)
  if (!value) throw new Error("--" + name + " is required")
  return value
}

const catalogPath = required("catalog")
const templatePath = required("template")
const id = required("id")
const repository = required("repository")
const digest = required("digest")
const rev = required("rev")
const flake = required("flake")

// A tag is a moving target; a digest is the artifact. Refusing anything else
// here means the pin cannot be "pinned-ish".
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
  throw new Error("--digest must be sha256:<64 hex>, got: " + digest)
}

// Same reasoning one level up: an image nobody can rebuild from a revision is
// not evidence of anything. "unknown" is what git prints when it cannot answer,
// and it is the value that would quietly become the record.
if (!/^[0-9a-f]{40}$/.test(rev)) {
  throw new Error("--rev must be a full 40-character git revision, got: " + rev)
}

const catalog = JSON.parse(await readFile(catalogPath, "utf8"))
if (!Array.isArray(catalog.apps)) throw new Error(catalogPath + " has no apps array")

const template = JSON.parse(await readFile(templatePath, "utf8"))
if (template.id !== id) {
  throw new Error("template id " + template.id + " does not match --id " + id)
}

const entry = {
  ...template,
  image: repository + "@" + digest,
  source: { flake, rev },
}

const index = catalog.apps.findIndex((e) => e.id === id)
const created = index === -1
if (created) catalog.apps.push(entry)
else catalog.apps[index] = entry

// Same formatting as the file already uses, so a pin is a readable diff and the
// ConfigMap bundle stays byte-reproducible.
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n")

console.log(
  (created ? "added " : "updated ") + id + " in " + catalogPath + "\n" +
  "  image: " + entry.image + "\n" +
  "  rev:   " + rev + "\n" +
  "  note:  commit this, then webui/scripts/build-configmap.mjs regenerates the bundle",
)

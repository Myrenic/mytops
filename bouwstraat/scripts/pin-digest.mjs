#!/usr/bin/env node
// Write a promoted artifact into the mytops catalog.
//
// Two shapes, both of which end in something a launch can be verified against:
//
//   image mode  - the OCI image the bouwstraat pushed, pinned by digest.
//   disk mode   - the qcow2 the bouwstraat built, served by the in-cluster image
//                 store, pinned by the sha256 it was built to.
//
// Whichever runs, this is the only step that makes a bouwstraat build reachable:
// the catalog is what the API reads, and verify-catalog.mjs refuses an entry that
// has neither. That is deliberate - the alternative is a workspace that runs
// whatever a tag (or a file) happens to contain today.
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

const SHA256 = /^[0-9a-f]{64}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const REV = /^[0-9a-f]{40}$/

const catalogPath = required("catalog")
const templatePath = required("template")
const id = required("id")
const flake = required("flake")
const rev = required("rev")

// An image nobody can rebuild from a revision is not evidence of anything.
// "unknown" is what git prints when it cannot answer, and it is the value that
// would quietly become the record.
if (!REV.test(rev)) {
  throw new Error("--rev must be a full 40-character git revision, got: " + rev)
}

const catalog = JSON.parse(await readFile(catalogPath, "utf8"))
if (!Array.isArray(catalog.apps)) throw new Error(catalogPath + " has no apps array")

const template = JSON.parse(await readFile(templatePath, "utf8"))
if (template.id !== id) {
  throw new Error("template id " + template.id + " does not match --id " + id)
}

const entry = { ...template }

const diskUrl = args.get("disk-url")
const diskSha256 = args.get("disk-sha256")

if (diskUrl || diskSha256) {
  if (!diskUrl) throw new Error("--disk-url is required alongside --disk-sha256")
  if (!SHA256.test(diskSha256 ?? "")) {
    throw new Error("--disk-sha256 must be 64 hex characters, got: " + diskSha256)
  }
  // The disk is served from the cluster's own image store, so there is no image
  // reference to pin - the integrity comes from the checksum instead, which is
  // the same promise by a different mechanism.
  delete entry.image
  entry.diskUrl = diskUrl
  entry.source = { flake, rev, sha256: diskSha256 }
} else {
  const repository = required("repository")
  const digest = args.get("digest")
  if (!DIGEST.test(digest ?? "")) {
    throw new Error("--digest must be sha256:<64 hex>, got: " + digest)
  }
  entry.image = repository + "@" + digest
  entry.source = { flake, rev }
  delete entry.diskUrl
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
  "  " + (entry.image ? "image: " + entry.image : "disk:  " + entry.diskUrl) + "\n" +
  (entry.source.sha256 ? "  sha256: " + entry.source.sha256 + "\n" : "") +
  "  rev:   " + rev + "\n" +
  "  note:  commit this, then webui/scripts/build-configmap.mjs regenerates the bundle",
)

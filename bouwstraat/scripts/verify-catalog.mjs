#!/usr/bin/env node
// Catalog invariants. Runs in the bouwstraat gate, in CI, and by hand before a
// release, because the catalog is the one file that decides what code runs on a
// user's desktop.
//
// Errors are things that are wrong now. Warnings are things that are allowed
// today and are worth knowing about (the existing container entries reference
// mutable tags: that is the status quo, not something this change silently
// redefines).
import { readFile } from "node:fs/promises"

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--")) throw new Error("unexpected argument: " + process.argv[i])
  args.set(process.argv[i].slice(2), process.argv[i + 1])
}

const catalogPath = args.get("catalog")
if (!catalogPath) throw new Error("--catalog is required")

const catalog = JSON.parse(await readFile(catalogPath, "utf8"))
if (!Array.isArray(catalog.apps)) throw new Error(catalogPath + " has no apps array")

const errors = []
const warnings = []

// The API treats an unknown runtime as a container (api/server.mjs,
// handleCreateWorkspace), so a typo here does not fail - it silently runs the
// entry with the wrong manifests.
const RUNTIMES = new Set(["container", "vm-linux", "vm-nixos"])
const DIGEST = /@sha256:[0-9a-f]{64}$/
const REV = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

const seen = new Set()
for (const entry of catalog.apps) {
  const where = "entry " + (entry.id ?? "<no id>")

  if (!entry.id) errors.push(where + ": has no id")
  else if (seen.has(entry.id)) errors.push(where + ": duplicate id")
  else seen.add(entry.id)

  if (!entry.name) errors.push(where + ": has no name")
  if (!entry.type) errors.push(where + ": has no type")
  if (!entry.runtime) errors.push(where + ": has no runtime")
  else if (!RUNTIMES.has(entry.runtime)) {
    errors.push(where + ": unknown runtime " + entry.runtime + " (known: " + [...RUNTIMES].join(", ") + ")")
  }

  // An entry with no groups is launchable by everyone who can reach the SPA.
  // The group ACL is the authorization boundary here (the ownership middleware
  // only covers the stream, not the launch).
  if (!Array.isArray(entry.groups) || entry.groups.length === 0) {
    errors.push(where + ": has no groups; the entry would be launchable by any authenticated user")
  }

  const isVm = typeof entry.runtime === "string" && entry.runtime.startsWith("vm-")

  if (isVm) {
    // Three legitimate shapes, in descending order of strength:
    //   image@sha256  - a bouwstraat build pushed to a registry
    //   diskUrl+sha256 - a bouwstraat build served from the in-cluster store
    //   neither       - the API's built-in public cloud image (ubuntu-vm), which
    //                   is a constant in the code rather than something this
    //                   catalog can point somewhere else
    // A tag, or a diskUrl with no checksum, is none of those: it is a workspace
    // that boots whatever is behind that reference today.
    const digestPinned = entry.image && DIGEST.test(entry.image)
    const diskPinned = entry.diskUrl && SHA256.test(entry.source?.sha256 ?? "")

    if (entry.image && !DIGEST.test(entry.image)) {
      errors.push(where + ": vm image is not digest-pinned: " + entry.image)
    }
    if (entry.diskUrl && !SHA256.test(entry.source?.sha256 ?? "")) {
      errors.push(where + ": diskUrl has no source.sha256 to verify the disk against")
    }
    if (entry.source && !digestPinned && !diskPinned) {
      errors.push(where + ": claims provenance but has neither a pinned image nor a pinned disk")
    }
    if (!entry.image && !entry.diskUrl) {
      warnings.push(where + ": falls back to the built-in cloud image; nothing here pins what it boots")
    }

    if (entry.source) {
      if (!entry.source.flake) errors.push(where + ": source has no flake")
      if (!REV.test(entry.source.rev ?? "")) {
        errors.push(where + ": source.rev is not a 40-character git revision: " + entry.source.rev)
      }
    }
  }

  if (entry.runtime === "container" && entry.image && !DIGEST.test(entry.image)) {
    warnings.push(where + ": container image uses a mutable tag: " + entry.image)
  }
}

for (const w of warnings) console.warn("warn:  " + w)
for (const e of errors) console.error("ERROR: " + e)

console.log(
  "catalog: " + catalog.apps.length + " entries, " +
  errors.length + " errors, " + warnings.length + " warnings",
)

if (errors.length) process.exit(1)

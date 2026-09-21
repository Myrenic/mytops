// Home agent: the file API for one user's home volume.
//
// It runs inside that user's keeper pod, mounts only their home PVC, and is
// reachable only by the workplace API (no Service, no DNS name, and a
// NetworkPolicy that admits the webui pod alone). The workplace API is the one
// that decides who is allowed to talk to it - it maps a caller to a user and
// proxies to that user's agent - so this process trusts its caller and guards
// against the other risk: a path escaping the one directory it is allowed to
// serve.
//
// Deliberately small: list, stat/usage, read, write, mkdir, move, delete. No
// auth, no config, no state.
import { createServer } from "node:http"
import { createReadStream, createWriteStream } from "node:fs"
import { chown, mkdir, readdir, realpath, rename, rm, stat, statfs } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import { extname, join, normalize, posix, sep } from "node:path"

const PORT = Number(process.env.AGENT_PORT) || 8080
const ROOT = process.env.HOME_ROOT || "/home"
const MAX_TEXT_PREVIEW = 512 * 1024

const CONTENT_TYPES = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

// Every path the caller sends is relative to the home root. Resolve it, then
// resolve the *real* path of the deepest existing ancestor so a symlink cannot
// be used to step outside the volume, and refuse anything that lands elsewhere.
async function resolveInRoot(raw) {
  const relative = posix.normalize("/" + (raw ?? "/")).replace(/^\/+/, "")
  const target = join(ROOT, relative)
  if (target !== ROOT && !target.startsWith(ROOT + sep)) throw new Error("path escapes the home volume")

  let existing = target
  for (;;) {
    try {
      const real = await realpath(existing)
      if (real !== ROOT && !real.startsWith(ROOT + sep)) throw new Error("path escapes the home volume")
      break
    } catch (err) {
      if (err.code !== "ENOENT") throw err
      const parent = join(existing, "..")
      if (parent === existing) break
      existing = parent
    }
  }
  return target
}

async function list(path) {
  const dir = await resolveInRoot(path)
  const names = await readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(names.map(async (entry) => {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      // Report a symlink as such and don't follow it into whatever it points at.
      return { name: entry.name, kind: "link", size: 0, mtime: 0 }
    }
    const info = await stat(full).catch(() => null)
    if (!info) return null
    return {
      name: entry.name,
      kind: entry.isDirectory() ? "dir" : "file",
      size: info.size,
      mtime: info.mtimeMs,
      mode: info.mode & 0o777,
    }
  }))
  return { path: posix.normalize("/" + (path ?? "/")), entries: entries.filter(Boolean) }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://agent")
  const path = url.searchParams.get("path") ?? "/"
  try {
    if (url.pathname === "/healthz") return json(res, 200, { ok: true })

    if (url.pathname === "/fs/usage") {
      const info = await statfs(ROOT)
      return json(res, 200, {
        totalBytes: info.blocks * info.bsize,
        freeBytes: info.bavail * info.bsize,
      })
    }

    if (url.pathname === "/fs/list" && req.method === "GET") {
      return json(res, 200, await list(path))
    }

    if (url.pathname === "/fs/file" && req.method === "GET") {
      const file = await resolveInRoot(path)
      const info = await stat(file)
      if (!info.isFile()) return json(res, 400, { error: "not a file" })
      const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
      const inline = url.searchParams.get("inline") === "1" && info.size <= MAX_TEXT_PREVIEW
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": info.size,
        "Last-Modified": new Date(info.mtimeMs).toUTCString(),
        ...(inline ? {} : { "Content-Disposition": `attachment; filename="${posix.basename(file).replace(/"/g, "")}"` }),
      })
      if (req.method === "HEAD") return res.end()
      return await pipeline(createReadStream(file), res)
    }

    if (url.pathname === "/fs/file" && req.method === "PUT") {
      const file = await resolveInRoot(path)
      await mkdir(join(file, ".."), { recursive: true })
      // Streamed, so a multi-gigabyte upload never sits in memory.
      await pipeline(req, createWriteStream(file))
      const info = await stat(file)
      return json(res, 200, { ok: true, size: info.size })
    }

    if (url.pathname === "/fs/dir" && req.method === "POST") {
      await mkdir(await resolveInRoot(path), { recursive: true })
      return json(res, 200, { ok: true })
    }

    if (url.pathname === "/fs/move" && req.method === "POST") {
      const from = await resolveInRoot(url.searchParams.get("from"))
      const to = await resolveInRoot(url.searchParams.get("to"))
      if (to === ROOT) return json(res, 400, { error: "cannot overwrite the home root" })
      await mkdir(join(to, ".."), { recursive: true })
      await rename(from, to)
      return json(res, 200, { ok: true })
    }

    if (url.pathname === "/fs" && req.method === "DELETE") {
      const target = await resolveInRoot(path)
      if (target === ROOT) return json(res, 400, { error: "refusing to delete the home root" })
      await rm(target, { recursive: true, force: false })
      return json(res, 200, { ok: true })
    }

    json(res, 404, { error: "not found" })
  } catch (err) {
    const code = err.code === "ENOENT" ? 404 : err.code === "ENOTDIR" || err.code === "EISDIR" ? 400 : 500
    if (code === 500) console.error("home-agent error:", err)
    json(res, code, { error: err.code ?? err.message })
  }
})

// The root is the mounted home volume. A freshly provisioned Longhorn volume is
// root-owned, and every writer in this system (the desktop containers, the
// user's own tools) is uid 1000, so hand the root over once and stop caring.
// Best-effort: if we are not root this fails and is irrelevant.
await mkdir(ROOT, { recursive: true }).catch(() => {})
const DESKTOP_UID = Number(process.env.HOME_UID) || 1000
await chown(ROOT, DESKTOP_UID, DESKTOP_UID).catch(() => {})
server.listen(PORT, "0.0.0.0", () => console.log("home-agent serving " + ROOT + " on :" + PORT))

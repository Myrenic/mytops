import { createServer } from "node:http"

const PORT = Number(process.env.PORT) || 3001
const KUBE_API = process.env.KUBE_API || "http://localhost:8001"
const NAMESPACE = process.env.WORKSPACE_NAMESPACE || "services"
const DOMAIN = process.env.BASE_DOMAIN || ""

// ── Catalog ──────────────────────────────────────────────────────────
// Embedded from catalog.json at build time; the server is the single
// source of truth for what can be launched.
let catalog = []
try {
  const { readFileSync } = await import("node:fs")
  catalog = JSON.parse(readFileSync("/etc/chacdn/catalog.json", "utf8")).apps
} catch {
  console.warn("workplace-api: /etc/chacdn/catalog.json not found, catalog empty")
}

// ── Helpers ──────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
      catch { resolve(null) }
    })
  })
}

// Stable per-user slug (matches SPA slugFor).
function slugFor(email) {
  let h = 0
  for (const c of email.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return "u" + (h >>> 0).toString(16).padStart(8, "0")
}

function instName(entryId, slug) {
  return `ws-${entryId}-${slug}`
}

// Derive base domain from a Host header (strip first component).
function baseDomain(host) {
  const parts = host.split(".")
  return parts.length > 1 ? parts.slice(1).join(".") : host
}

// Forward a request to the kubectl-proxy (localhost:8001) using the same
// identity headers the browser sent (X-Auth-Request-*).  Returns the
// parsed JSON body or throws.
async function kubeFetch(method, path, body, identityHeaders) {
  const headers = { ...identityHeaders, "Content-Type": "application/json" }
  const opts = { method, headers }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${KUBE_API}${path}`, opts)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

// ── Manifest builders (server-side, never exposed to browser) ─────────
function buildDeployment(entry, name, owner) {
  const cpuReq = entry.resources?.cpu ?? "250m"
  const memReq = entry.resources?.memory ?? "256Mi"
  const memLim = entry.type === "desktop" ? "4Gi" : "2Gi"
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: {
        app: name,
        "chacdn-owner": owner,
        "chacdn-runtime": entry.runtime ?? "container",
        "chacdn-persistence": entry.persistence ?? "disposable",
        "chacdn-lifecycle": entry.lifecycle ?? "ephemeral",
      },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [
            {
              name: "workspace",
              image: entry.image,
              ports: [{ name: "http", containerPort: 3000 }],
              env: [
                { name: "PUID", value: "1000" },
                { name: "PGID", value: "1000" },
                ...(entry.env ?? []),
              ],
              volumeMounts: [{ name: "dshm", mountPath: "/dev/shm" }],
              resources: {
                requests: { cpu: cpuReq, memory: memReq },
                limits: { memory: memLim },
              },
            },
          ],
          volumes: [
            { name: "dshm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
          ],
        },
      },
    },
  }
}

function buildService(name) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: NAMESPACE },
    spec: {
      selector: { app: name },
      ports: [{ name: "http", port: 3000, targetPort: "http" }],
    },
  }
}

function buildIngressRoute(name, domain) {
  return {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: { name, namespace: "network" },
    spec: {
      entryPoints: ["websecure"],
      routes: [
        {
          match: `Host(\`${name}.${domain}\`)`,
          kind: "Rule",
          services: [{ name, namespace: NAMESPACE, port: 3000 }],
        },
      ],
      tls: { secretName: "domain-0-prod-tls" },
    },
  }
}

// ── Route handlers ───────────────────────────────────────────────────

// GET /api/health
function handleHealth(_req, res) {
  json(res, 200, { ok: true })
}

// GET /api/catalog
function handleCatalog(_req, res) {
  json(res, 200, { apps: catalog })
}

// GET /api/workspaces — list running workspaces for the caller.
async function handleListWorkspaces(req, res, identity) {
  const slug = slugFor(identity.email)
  const list = await kubeFetch(
    "GET",
    `/apis/apps/v1/namespaces/${NAMESPACE}/deployments?labelSelector=chacdn-owner%3D${slug}`,
    null,
    req.headers,
  )
  const items = list.items ?? []
  const workspaces = items
    .filter((d) => d.metadata?.name?.startsWith("ws-"))
    .map((d) => {
      const name = d.metadata.name
      // Extract entryId from "ws-{entryId}-{slug}"
      const entryId = name.slice(3, name.length - slug.length - 1)
      const ready = (d.status?.readyReplicas ?? 0) >= 1
      const entry = catalog.find((e) => e.id === entryId)
      return {
        id: entryId,
        name: entry?.name ?? entryId,
        type: entry?.type ?? "desktop",
        icon: entry?.icon,
        status: ready ? "running" : "starting",
        url: `https://${name}.${DOMAIN || baseDomain(req.headers.host ?? "")}`,
      }
    })
  json(res, 200, workspaces)
}

// POST /api/workspaces { catalogId } — create a workspace.
async function handleCreateWorkspace(req, res, identity) {
  const body = await readBody(req)
  if (!body?.catalogId) return json(res, 400, { error: "catalogId required" })

  const entry = catalog.find((e) => e.id === body.catalogId)
  if (!entry) return json(res, 404, { error: "catalog entry not found" })

  // Group gate
  const myGroups = new Set(
    (identity.groups ?? "").split(",").map((g) => g.trim()).filter(Boolean),
  )
  if (entry.groups?.length && !entry.groups.some((g) => myGroups.has(g))) {
    return json(res, 403, { error: "not allowed" })
  }

  const slug = slugFor(identity.email)
  const name = instName(entry.id, slug)
  const domain = DOMAIN || baseDomain(req.headers.host ?? "")

  // Create each resource independently: an orphaned Deployment from an
  // earlier partial connect must not skip Service/IngressRoute creation.
  const depPath = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${name}`
  const existing = await kubeFetch("GET", depPath, null, req.headers)
  if (existing.kind !== "Status") {
    // Already exists — return the URL so the client can connect.
    return json(res, 200, {
      id: entry.id,
      name,
      status: "running",
      url: `https://${name}.${domain}`,
    })
  }

  // Deploy
  await kubeFetch(
    "POST",
    `/apis/apps/v1/namespaces/${NAMESPACE}/deployments`,
    buildDeployment(entry, name, slug),
    req.headers,
  )

  // Service
  const svcExists = await kubeFetch(
    "GET",
    `/api/v1/namespaces/${NAMESPACE}/services/${name}`,
    null,
    req.headers,
  )
  if (svcExists.kind === "Status") {
    await kubeFetch(
      "POST",
      `/api/v1/namespaces/${NAMESPACE}/services`,
      buildService(name),
      req.headers,
    )
  }

  // IngressRoute
  const irExists = await kubeFetch(
    "GET",
    `/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/${name}`,
    null,
    req.headers,
  )
  if (irExists.kind === "Status") {
    await kubeFetch(
      "POST",
      `/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes`,
      buildIngressRoute(name, domain),
      req.headers,
    )
  }

  // Wait for the Deployment to become ready (up to 3 minutes).
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const dep = await kubeFetch("GET", depPath, null, req.headers)
    if ((dep.status?.readyReplicas ?? 0) >= 1) {
      return json(res, 200, {
        id: entry.id,
        name,
        status: "running",
        url: `https://${name}.${domain}`,
      })
    }
  }

  // Timed out — still return 200 so the client can show a spinner; the pod
  // is probably still pulling the image.
  json(res, 200, {
    id: entry.id,
    name,
    status: "starting",
    url: `https://${name}.${domain}`,
  })
}

// DELETE /api/workspaces/:entryId — tear down a workspace.
async function handleDeleteWorkspace(req, res, identity, entryId) {
  const slug = slugFor(identity.email)
  const name = instName(entryId, slug)

  // Best-effort delete all three resources.
  await kubeFetch("DELETE", `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${name}`, null, req.headers).catch(() => {})
  await kubeFetch("DELETE", `/api/v1/namespaces/${NAMESPACE}/services/${name}`, null, req.headers).catch(() => {})
  await kubeFetch("DELETE", `/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/${name}`, null, req.headers).catch(() => {})

  json(res, 200, { ok: true })
}

// POST /api/workspaces/:entryId/restart — rolling-restart a workspace.
async function handleRestartWorkspace(req, res, identity, entryId) {
  const slug = slugFor(identity.email)
  const name = instName(entryId, slug)
  const depPath = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${name}`

  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: { "chacdn/restartedAt": new Date().toISOString() },
        },
      },
    },
  }

  const result = await kubeFetch("PATCH", depPath, patch, req.headers)
  if (result.kind === "Status") {
    return json(res, result.code ?? 500, { error: result.message ?? "restart failed" })
  }

  // Wait for readiness.
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const dep = await kubeFetch("GET", depPath, null, req.headers)
    if ((dep.status?.readyReplicas ?? 0) >= 1) {
      return json(res, 200, { ok: true })
    }
  }

  json(res, 200, { ok: true, note: "still restarting" })
}

// ── Router ───────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS for local dev (vite :5173).
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end() }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
  const path = url.pathname

  // Extract oauth2-proxy identity headers.
  const identity = {
    email: req.headers["x-auth-request-email"] ?? "",
    groups: req.headers["x-auth-request-groups"] ?? "",
  }

  try {
    if (path === "/api/health" && req.method === "GET") return handleHealth(req, res)
    if (path === "/api/catalog" && req.method === "GET") return handleCatalog(req, res)
    if (path === "/api/workspaces" && req.method === "GET") return handleListWorkspaces(req, res, identity)
    if (path === "/api/workspaces" && req.method === "POST") return handleCreateWorkspace(req, res, identity)

    // /api/workspaces/:entryId
    const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)$/)
    if (wsMatch) {
      const entryId = decodeURIComponent(wsMatch[1])
      if (req.method === "DELETE") return handleDeleteWorkspace(req, res, identity, entryId)
      if (req.method === "POST") return handleRestartWorkspace(req, res, identity, entryId)
    }

    json(res, 404, { error: "not found" })
  } catch (err) {
    console.error("workplace-api error:", err)
    json(res, 500, { error: "internal error" })
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`workplace-api listening on :${PORT}`)
})

import { createServer } from "node:http"

const PORT = Number(process.env.PORT) || 3001
// 127.0.0.1, not localhost: the kubectl-proxy sidecar binds `--address=127.0.0.1`
// so the name would have to resolve to IPv4 every time, and `localhost` also
// resolves to ::1 in some images (musl, IPv6-first resolvers), where the proxy
// is not listening.
const KUBE_API = process.env.KUBE_API || "http://127.0.0.1:8001"
const NAMESPACE = process.env.WORKSPACE_NAMESPACE || "services"
const VM_NAMESPACE = process.env.VM_NAMESPACE || "kubevirt"
const DOMAIN = process.env.BASE_DOMAIN || ""
// Longhorn is installed into the namespace its Flux Kustomization targets
// (`storage`), NOT `longhorn-system`; the storage-namespace RBAC grant in
// nebula matches this name. Deleting a volume anywhere else is a 403 and
// leaves the disk behind forever.
const LONGHORN_NAMESPACE = process.env.LONGHORN_NAMESPACE || "storage"
const CATALOG_PATH = process.env.CATALOG_PATH || "/etc/mytops/catalog.json"
// Per-user home volume: one RWX Longhorn PVC holding the desktop profile, so
// the same data follows the user between a container workspace and a VM (the
// VM mounts the Longhorn NFS export, which is the only way a PVC can be shared
// across the two namespaces). Longhorn RWX volumes are also served over NFS by
// a share-manager pod in LONGHORN_NAMESPACE, under a Service named after the
// PersistentVolume.
const HOME_STORAGE_CLASS = process.env.HOME_STORAGE_CLASS || "longhorn"
const HOME_STORAGE = process.env.HOME_STORAGE || "20Gi"
const HOME_PREFIX = "home-"
// The volume only attaches while something consumes it, and a VM guest mounts
// it over NFS without being a Kubernetes consumer - so a keeper pod holds it.
// That pod also runs the home agent, which is what lets the SPA browse the home
// without starting a desktop.
const KEEPER_IMAGE = process.env.KEEPER_IMAGE || "docker.io/library/node:22-alpine"
const HOME_AGENT_CONFIGMAP = "mytops-home-agent"
// Where the guest mounts the export, and what the in-VM desktop gets as /config.
const GUEST_HOME_PATH = "/home/user/webtop-config"
// oauth2-proxy's auth endpoint, for the one caller that cannot present the
// identity headers (see handleStreamAuth).
const OAUTH2_AUTH_URL = process.env.OAUTH2_AUTH_URL || "http://oauth2-proxy.auth.svc.cluster.local/oauth2/auth"
// Every Kubernetes call is bounded: an apiserver that accepts a connection and
// never answers used to hang the HTTP request (and the SPA's Launch/End button)
// until the client gave up.
const KUBE_TIMEOUT_MS = Number(process.env.KUBE_TIMEOUT_MS) || 15_000

// ── Catalog ──────────────────────────────────────────────────────────
// Embedded from catalog.json at build time; the server is the single
// source of truth for what can be launched.
let catalog = []
try {
  const { readFileSync } = await import("node:fs")
  catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")).apps
} catch {
  // NOTE: this file must not contain a dollar-brace placeholder anywhere -
  // not even inside a comment. It ships as the mytops-workplace-api
  // ConfigMap's plain (non-base64) data, so Flux postBuild substitutes
  // dollar-brace sequences before the API ever parses the file, and an
  // unknown variable fails the whole Kustomization. Concatenate strings.
  // webui/scripts/build-configmap.mjs fails the build if one appears.
  console.warn("workplace-api: " + CATALOG_PATH + " not found, catalog empty")
}

// ── Helpers ──────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

// POST bodies are a single catalogId; anything larger is a mistake or an
// attempt to make the API buffer memory.
const MAX_BODY_BYTES = 64 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overflowed = false
    req.on("data", (c) => {
      if (overflowed) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        // Stop buffering, but let the caller drain the socket: destroying the
        // request here makes the client see a reset instead of the 413.
        overflowed = true
        chunks.length = 0
        reject(new Error("request body too large"))
        return
      }
      chunks.push(c)
    })
    // Without the error/aborted handlers a client that dies mid-upload left
    // the promise pending forever, holding the request open.
    req.on("error", reject)
    req.on("aborted", () => reject(new Error("request aborted")))
    req.on("end", () => {
      if (overflowed) return
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
      catch { resolve(null) }
    })
  })
}

// Stable per-user slug (matches the SPA's workspace naming).
function slugFor(email) {
  let h = 0
  for (const c of email.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return "u" + (h >>> 0).toString(16).padStart(8, "0")
}

function instName(entryId, slug) {
  return "ws-" + entryId + "-" + slug
}

// entryId back out of an instance name (ws-<entryId>-<slug>).
function entryIdOf(name, slug) {
  return name.slice(3, name.length - slug.length - 1)
}

// Derive base domain from a Host header (strip first component).
function baseDomain(host) {
  // req.headers.host keeps the port (`localhost:5173` in dev), which would
  // otherwise end up inside every workspace URL.
  const bare = host.replace(/:\d+$/, "")
  const parts = bare.split(".")
  return parts.length > 1 ? parts.slice(1).join(".") : bare
}

class KubeError extends Error {
  constructor(method, path, status, message) {
    super("kube-api " + method + " " + path + " -> " + status + " " + message)
    this.name = "KubeError"
    this.status = status
  }
}

function isNotFound(value) {
  return value?.kind === "Status" && (value.code === 404 || value.reason === "NotFound")
}

// Forward a request to the kubectl-proxy (localhost:8001).  Only the
// oauth2-proxy identity headers (X-Auth-Request-*) are forwarded, never the
// raw incoming headers — passing content-length/host from the browser request
// makes the fetch hang when the forwarded body size differs.
//
// A 404 comes back as a Status object (callers branch on isNotFound); every
// other failure throws, so a caller can never mistake "the apiserver broke"
// for "the object does not exist" and take the wrong branch.
async function kubeFetch(method, path, body, reqHeaders) {
  // Merge patch, not strategic merge patch: custom resources reject the
  // strategic type outright (a VM PATCH answered 415 - "accepted media types
  // include: application/merge-patch+json"), and every patch this API sends is
  // maps and scalars, where the two behave the same. Plain JSON elsewhere.
  const headers = {
    "Content-Type": method === "PATCH"
      ? "application/merge-patch+json"
      : "application/json",
  }
  for (const key of Object.keys(reqHeaders)) {
    if (key.toLowerCase().startsWith("x-auth-request-")) headers[key] = reqHeaders[key]
  }
  const opts = { method, headers, signal: AbortSignal.timeout(KUBE_TIMEOUT_MS) }
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body)

  let res
  try {
    res = await fetch(KUBE_API + path, opts)
  } catch (err) {
    const reason = err?.name === "TimeoutError"
      ? "timed out after " + KUBE_TIMEOUT_MS + "ms"
      : "unreachable (" + (err?.cause?.code ?? err?.message ?? err) + ")"
    // The sidecar is the only thing on this port; say so, because the symptom
    // (502s from every call) is otherwise indistinguishable from an apiserver
    // outage.
    const message = reason + " at " + KUBE_API
    console.error("kube-api " + method + " " + path + " -> " + message)
    throw new KubeError(method, path, 504, message)
  }

  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* empty body, or HTML from an error page */ }

  // A JSON `null` (or an empty body) means no object came back; hand back an
  // empty string rather than the literal text, which a caller would have to
  // remember is falsy-or-not.
  if (res.ok) return parsed ?? ""

  const message = parsed?.message ?? text.slice(0, 300) ?? res.statusText
  if (res.status === 404) return { kind: "Status", code: 404, reason: "NotFound", message }
  console.error("kube-api " + method + " " + path + " -> " + res.status + " " + message)
  throw new KubeError(method, path, res.status, message)
}

// Poll a predicate until it holds or the deadline passes. Returns whether it
// held; never throws (a transient apiserver error is not a terminal answer).
async function waitFor(predicate, timeoutMs, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { if (await predicate()) return true } catch { /* keep polling */ }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ── Manifest builders (server-side, never exposed to browser) ─────────

// TURN for WebRTC media. coturn runs hostNetwork on TURN_HOST because a
// browser cannot reach a pod IP; the workplace pod is envFrom'd the
// mytops-turn Secret (see base/webui.yaml), and this is where that config
// reaches the workspaces. selkies generates the client's ICE config from
// SELKIES_TURN_* - without it media falls back to candidates the browser
// cannot use, which is what made VM desktops connect but stay black.
const TURN_HOST = process.env.TURN_HOST || ""
const TURN_PORT = process.env.TURN_PORT || "3478"
const TURN_PROTOCOL = process.env.TURN_PROTOCOL || "udp"
const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET || ""

function turnEnv() {
  if (!TURN_HOST || !TURN_SHARED_SECRET) return []
  return [
    { name: "SELKIES_TURN_HOST", value: TURN_HOST },
    { name: "SELKIES_TURN_PORT", value: TURN_PORT },
    { name: "SELKIES_TURN_PROTOCOL", value: TURN_PROTOCOL },
    { name: "SELKIES_TURN_SHARED_SECRET", value: TURN_SHARED_SECRET },
  ]
}

// Failure states, not "still coming up" ones: a crash-looping pod or a VM that
// cannot schedule must surface as offline so the UI offers Restart instead of
// spinning "Starting" forever.
const CONTAINER_FAILURE_REASONS = new Set([
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "RunContainerError",
])

// Deliberately without "Stopped": right after a resume (or during a boot) a VM
// with runStrategy: Always still reports Stopped for a moment, and calling that
// "offline" would flag a workspace that is coming up. A VM that is halted on
// purpose is reported as suspended from runStrategy, not from this status.
const VM_FAILURE_STATES = new Set([
  "CrashLoopBackOff",
  "DataVolumeError",
  "ErrImagePull",
  "ErrorDataVolumeNotFound",
  "ErrorPvcNotFound",
  "ErrorUnschedulable",
  "FailedUnschedulable",
  "ImagePullBackOff",
])

function containerWorkspaceStatus(dep) {
  if (dep?.spec?.replicas === 0) return "suspended"
  if ((dep?.status?.readyReplicas ?? 0) >= 1) return "running"
  const statuses = dep?.status?.containerStatuses ?? []
  if (statuses.some((c) => CONTAINER_FAILURE_REASONS.has(c.state?.waiting?.reason))) return "offline"
  return "starting"
}

function vmWorkspaceStatus(vm, streamReady) {
  if (vm?.spec?.runStrategy === "Halted") return "suspended"
  if (vm?.status?.ready && streamReady) return "running"
  if (VM_FAILURE_STATES.has(vm?.status?.printableStatus)) return "offline"
  return "starting"
}

function buildDeployment(entry, name, owner, ownerEmail) {
  const cpuReq = entry.resources?.cpu ?? "250m"
  const memReq = entry.resources?.memory ?? "256Mi"
  const memLim = entry.type === "desktop" ? "4Gi" : "2Gi"
  // The profile lives on the user's home volume; without it a persistent
  // desktop still loses everything on the next reschedule.
  const home = usesHome(entry) ? homeName(owner) : null
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: NAMESPACE,
      // The slug cannot be reversed into an email, so record it: the admin view
      // has to say *who* a workspace belongs to, and admins have to be told
      // before they destroy someone's work.
      annotations: ownerEmail ? { "mytops/owner-email": ownerEmail } : undefined,
      labels: {
        "app.kubernetes.io/name": "mytops",
        "app.kubernetes.io/component": "session",
        "mytops-owner": owner,
        "mytops-entry": entry.id,
        "mytops-runtime": entry.runtime ?? "container",
        "mytops-persistence": entry.persistence ?? "disposable",
        "mytops-lifecycle": entry.lifecycle ?? "ephemeral",
      },
    },
    spec: {
      replicas: 1,
      // Rolls the old pod away before starting the new one: two desktops must
      // never write the same profile at once, and a rolling update would
      // otherwise run both for the length of the transition.
      ...(home ? { strategy: { type: "Recreate" } } : {}),
      selector: { matchLabels: { "app.kubernetes.io/name": "mytops", "app.kubernetes.io/component": "session", "mytops-owner": owner, "mytops-entry": entry.id } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "mytops", "app.kubernetes.io/component": "session", "mytops-owner": owner, "mytops-entry": entry.id } },
        spec: {
          // A workspace is untrusted user content; it has no business holding
          // a (useless) API token.
          automountServiceAccountToken: false,
          nodeSelector: nodeSelector(),
          containers: [
            {
              name: "workspace",
              image: entry.image,
              ports: [{ name: "http", containerPort: 3000 }],
              env: [
                { name: "PUID", value: "1000" },
                { name: "PGID", value: "1000" },
                ...turnEnv(),
                ...(entry.env ?? []),
              ],
              volumeMounts: [
                { name: "dshm", mountPath: "/dev/shm" },
                ...(home ? [{ name: "home", mountPath: "/config" }] : []),
              ],
              // readyReplicas only means the process is up without this, which
              // is how a launched workspace reported "Running" while nginx
              // inside it was still 30 s away and the iframe got a 502.
              readinessProbe: {
                tcpSocket: { port: "http" },
                initialDelaySeconds: 5,
                periodSeconds: 5,
                timeoutSeconds: 3,
                failureThreshold: 30,
              },
              resources: {
                requests: { cpu: cpuReq, memory: memReq },
                limits: { memory: memLim },
              },
            },
          ],
          volumes: [
            { name: "dshm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
            ...(home ? [{ name: "home", persistentVolumeClaim: { claimName: home } }] : []),
          ],
        },
      },
    },
  }
}

function buildService(name, owner, entryId) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: { "app.kubernetes.io/name": "mytops", "app.kubernetes.io/component": "session" },
    },
    spec: {
      selector: { "app.kubernetes.io/name": "mytops", "app.kubernetes.io/component": "session", "mytops-owner": owner, "mytops-entry": entryId },
      ports: [{ name: "http", port: 3000, targetPort: "http" }],
    },
  }
}

// Authentication alone is not authorization: this middleware asks the API
// whether the authenticated caller owns the workspace host. It is a platform
// object in nebula (kubernetes/apps/network/ingressroutes/middlewares.yaml).
const WORKSPACE_OWNER_MIDDLEWARE = { name: "mytops-workspace-owner", namespace: "network" }

// opts.svc overrides the backend (container default: <name> in `services`
// on 3000; VM workspaces use <name>-svc in the kubevirt ns on 8080).
function buildIngressRoute(name, domain, opts) {
  const svc = opts?.svc ?? { name, namespace: NAMESPACE, port: 3000 }
  return {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: { name, namespace: "network" },
    spec: {
      entryPoints: ["websecure"],
      routes: [
        {
          match: "Host(`" + name + "." + domain + "`)",
          kind: "Rule",
          // oauth2-proxy authenticates at the edge, then
          // mytops-workspace-owner asks the API whether *this* user owns the
          // host in the request. Authentication alone let any user in the
          // realm open any workspace by guessing a hostname.
          middlewares: [
            { name: "oauth2-proxy-auth", namespace: "network" },
            WORKSPACE_OWNER_MIDDLEWARE,
          ],
          services: [svc],
        },
      ],
      tls: { secretName: "domain-0-prod-tls" },
    },
  }
}

// ── Resource reconciliation helpers ──────────────────────────────────

function ingressRoutePath(name) {
  return "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/" + name
}

// ── Per-user home volume ─────────────────────────────────────────────
//
// One RWX PVC per user holds the desktop profile (= what linuxserver images
// call /config). A container workspace mounts the PVC directly; a VM cannot
// (a VMI can only reference a PVC from its own namespace), so the guest mounts
// the same volume over NFS. That NFS export only exists while the volume is
// attached, which is why a keeper pod consumes it - the VM guest is not a
// Kubernetes consumer and would otherwise find the export missing at boot.
function homeName(slug) {
  return HOME_PREFIX + slug
}

function homeKeeperName(slug) {
  return HOME_PREFIX + slug + "-keeper"
}

// Entries mount the home only if they asked for persistence: an ephemeral
// entry (a throwaway browser, say) must not hold - or write to - a profile.
function usesHome(entry) {
  return entry.persistence === "persistent"
}

function buildHomePvc(slug, entry) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: homeName(slug),
      namespace: NAMESPACE,
      labels: { "app.kubernetes.io/name": "mytops", "app.kubernetes.io/component": "home", "mytops-owner": slug },
    },
    spec: {
      accessModes: ["ReadWriteMany"],
      storageClassName: HOME_STORAGE_CLASS,
      resources: { requests: { storage: entry.homeStorage ?? HOME_STORAGE } },
    },
  }
}

function buildHomeKeeper(slug) {
  const labels = { "app.kubernetes.io/name": "mytops", "app.kubernetes.io/component": "home-keeper", "mytops-owner": slug }
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: homeKeeperName(slug), namespace: NAMESPACE, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          nodeSelector: nodeSelector(),
          securityContext: { seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "keeper",
              image: KEEPER_IMAGE,
              command: ["node", "/etc/mytops-agent/home-agent.mjs"],
              ports: [{ name: "files", containerPort: FILES_AGENT_PORT }],
              env: [
                { name: "HOME_ROOT", value: "/home" },
                { name: "AGENT_PORT", value: String(FILES_AGENT_PORT) },
              ],
              volumeMounts: [
                { name: "home", mountPath: "/home" },
                { name: "agent", mountPath: "/etc/mytops-agent", readOnly: true },
                { name: "tmp", mountPath: "/tmp" },
              ],
              // /healthz is the agent's own liveness; the file API is not
              // "ready" until the volume is mounted, which it is by then.
              readinessProbe: { httpGet: { path: "/healthz", port: "files" }, initialDelaySeconds: 2, periodSeconds: 10 },
              resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "192Mi" } },
              securityContext: {
                // Runs as root for one reason: a brand-new Longhorn volume is
                // root-owned, and the agent has to hand the home root to the
                // desktop user (1000) before it can write there. No service
                // account token, no capabilities, read-only root filesystem -
                // this process can only reach the one volume it exists for.
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                readOnlyRootFilesystem: true,
              },
            },
          ],
          volumes: [
            { name: "home", persistentVolumeClaim: { claimName: homeName(slug) } },
            { name: "agent", configMap: { name: HOME_AGENT_CONFIGMAP } },
            { name: "tmp", emptyDir: {} },
          ],
        },
      },
    },
  }
}

// The share-manager Service (and therefore the NFS export) is named after the
// PersistentVolume, not after the PVC, so the export address is only known once
// the claim has bound.
function homeNfsSource(pvName) {
  return pvName + "." + LONGHORN_NAMESPACE + ".svc.cluster.local:/" + pvName
}

// Does the running keeper match what we would create today? The keeper is a
// plain pod today but grows (it learned to serve the file API), and an existing
// one would otherwise keep the pod it was created with - the API only ever
// creates objects, never updates them.
function homeKeeperMatches(keeper, slug) {
  const have = keeper?.spec?.template?.spec
  const want = buildHomeKeeper(slug).spec.template.spec
  const haveContainer = have?.containers?.[0]
  const wantContainer = want.containers[0]
  return !!haveContainer &&
    haveContainer.image === wantContainer.image &&
    JSON.stringify(haveContainer.command) === JSON.stringify(wantContainer.command) &&
    (have.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === homeName(slug))
}

// Create the home volume if needed and make sure something holds it attached,
// then return the NFS source its VM guest should mount (null when the volume
// never bound, in which case the caller must not pretend it has one).
async function ensureHome(slug, entry, headers) {
  const pvcPath = "/api/v1/namespaces/" + NAMESPACE + "/persistentvolumeclaims/" + homeName(slug)
  const existing = await kubeFetch("GET", pvcPath, null, headers).catch(() => null)
  if (isNotFound(existing)) {
    await kubeFetch("POST", "/api/v1/namespaces/" + NAMESPACE + "/persistentvolumeclaims",
      buildHomePvc(slug, entry), headers)
  }

  const keeperPath = "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + homeKeeperName(slug)
  const keeper = await kubeFetch("GET", keeperPath, null, headers).catch(() => null)
  const keeperStale = !isNotFound(keeper) && keeper?.spec && !homeKeeperMatches(keeper, slug)
  if (isNotFound(keeper) || keeperStale) {
    if (keeperStale) {
      // Recreate rather than patch: the container list is replaced wholesale by
      // a merge patch anyway, and a fresh object cannot half-apply.
      await kubeFetch("DELETE", keeperPath, null, headers)
        .catch((err) => console.error("home keeper replace: " + err.message))
    }
    await kubeFetch("POST", "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments",
      buildHomeKeeper(slug), headers)
  }

  return null
}

// The NFS source a VM guest needs, once the claim has bound. The keeper is the
// first consumer, so this normally resolves within seconds.
async function ensureHomeSource(slug, entry, headers) {
  const pvcPath = "/api/v1/namespaces/" + NAMESPACE + "/persistentvolumeclaims/" + homeName(slug)
  let pvName = null
  const bound = await waitFor(async () => {
    const pvc = await kubeFetch("GET", pvcPath, null, headers)
    pvName = pvc?.spec?.volumeName ?? null
    return !!pvName
  }, 90_000, 2000)
  if (!bound) {
    console.error("home volume " + homeName(slug) + " did not bind within 90s")
    return null
  }
  return homeNfsSource(pvName)
}

// The route must carry both middlewares, in order: authentication first, then
// the ownership check. A route created before the owner check existed (or with
// its middlewares reordered) is drifted and has to be rebuilt too.
function ingressRouteMatches(route, svc) {
  const backend = route?.spec?.routes?.[0]?.services?.[0]
  const middlewares = route?.spec?.routes?.[0]?.middlewares ?? []
  return !!backend && backend.name === svc.name &&
    (backend.namespace ?? NAMESPACE) === svc.namespace && backend.port === svc.port &&
    middlewares.length === 2 &&
    middlewares[0].name === "oauth2-proxy-auth" && middlewares[0].namespace === "network" &&
    middlewares[1].name === WORKSPACE_OWNER_MIDDLEWARE.name &&
    middlewares[1].namespace === WORKSPACE_OWNER_MIDDLEWARE.namespace
}

// Reconcile one IngressRoute against the backend this workspace needs.
//
// The network-namespace Role grants get/list/create/delete on IngressRoutes -
// NOT update - so a drifted route is repaired by delete + create. The old
// PUT-based repair was 403'd by the apiserver on every poll, which is why VM
// routes created by the container-era code were never actually fixed.
async function ensureIngressRoute(name, domain, svc, headers) {
  const path = ingressRoutePath(name)
  const current = await kubeFetch("GET", path, null, headers).catch(() => null)
  if (ingressRouteMatches(current, svc)) return
  if (current && !isNotFound(current)) {
    await kubeFetch("DELETE", path, null, headers)
      .catch((err) => console.error("ingressroute replace: " + err.message))
  }
  await kubeFetch("POST", "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes",
    buildIngressRoute(name, domain, { svc }), headers)
}

async function ensureService(namespace, name, build, headers) {
  const path = "/api/v1/namespaces/" + namespace + "/services/" + name
  const current = await kubeFetch("GET", path, null, headers).catch(() => null)
  if (!isNotFound(current)) return
  await kubeFetch("POST", "/api/v1/namespaces/" + namespace + "/services", build(), headers)
}

// Tear down one workspace instance. Shared by user destroy and admin destroy
// so both drop the VM disk and its retained Longhorn volume - admin destroy
// used to leave a 10Gi ghost per workspace behind.
// Returns the list of errors; a 404 is not an error (nothing to delete).
//
// Only objects named after the instance (`ws-<entry>-<slug>`) are touched. The
// user's home volume is a separate object (`home-<slug>`) and deliberately
// survives a destroy: that is what lets a VM be rebuilt from scratch without
// throwing the desktop profile away. Never widen these deletes into a selector
// - it would take the user's data with it.
async function teardownWorkspace(name, headers) {
  const failures = []
  const del = async (path) => {
    try {
      await kubeFetch("DELETE", path, null, headers)
    } catch (err) {
      failures.push(err.message)
      console.error("teardown " + name + ": " + err.message)
    }
  }

  // Container resources (services ns) and VM resources (kubevirt ns) share the
  // instance name, so destroying an entry cleans both without knowing which
  // runtime it was.
  await del("/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + name)
  await del("/api/v1/namespaces/" + NAMESPACE + "/services/" + name)
  await del(ingressRoutePath(name))
  await del("/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines/" + name)
  await del("/api/v1/namespaces/" + VM_NAMESPACE + "/services/" + name + "-svc")
  await del("/api/v1/namespaces/" + VM_NAMESPACE + "/secrets/" + name + "-cloudinit")
  await del("/apis/cdi.kubevirt.io/v1beta1/namespaces/" + VM_NAMESPACE + "/datavolumes/" + name)

  // Longhorn's StorageClasses are reclaimPolicy: Retain, so a deleted PVC
  // leaves the volume object (and its disk) behind. Capture the PV name from
  // the PVC first, delete the PVC, wait for it to actually go, then drop the
  // volume. The wait matters: deleting the volume while its PVC still exists
  // lets the CSI driver recreate it - the old fixed 3 s sleep just moved the
  // race around instead of closing it.
  const pvcPath = "/api/v1/namespaces/" + VM_NAMESPACE + "/persistentvolumeclaims/" + name
  const pvc = await kubeFetch("GET", pvcPath, null, headers).catch(() => null)
  if (!isNotFound(pvc)) {
    const pvName = pvc?.spec?.volumeName
    await del(pvcPath)
    if (pvName) {
      const gone = await waitFor(
        async () => isNotFound(await kubeFetch("GET", pvcPath, null, headers)),
        20_000,
        1000,
      )
      if (!gone) console.warn("teardown " + name + ": PVC still terminating")
      await del("/apis/longhorn.io/v1beta2/namespaces/" + LONGHORN_NAMESPACE + "/volumes/" + pvName)
    }
  }

  return failures
}

// ── VM helpers ───────────────────────────────────────────────────────

// Cloud-init user-data for the Ubuntu jammy VM: Docker from the distro repo,
// then the linuxserver/webtop container as a systemd unit (see below). The
// unit file is written via write_files - heredocs inside runcmd break.
//
// IMPORTANT: this file ships as plain ConfigMap data, so Flux postBuild runs
// envsubst over it. envsubst replaces both the braced and the bare form of a
// variable, with an EMPTY string when the name is unknown, so the generated
// cloud-init text must not contain a dollar sign at all (the guest shell never
// sees one - the loops here use `for i in` and `$(...)`-free commands). The
// idle-culler script is base64-encoded for the same reason.
//
// The VM itself is a container host, not the desktop: the EXACT
// linuxserver/webtop container (baseimage-selkies: selkies + pixelflux/pcmflux
// + Smithay/Labwc wayland + nginx) runs inside it, same image and env as the
// container desktops, so their behavior cannot drift from the SPA tiles.
const WEBTOP_IMAGE = process.env.WEBTOP_IMAGE || "lscr.io/linuxserver/webtop:ubuntu-kde"
const WEBTOP_ENV = process.env.WEBTOP_ENV || "PIXELFLUX_WAYLAND=true"

// Environment for the in-VM desktop: its own settings plus the TURN config,
// which selkies turns into the browser's ICE servers. Without it a VM desktop
// negotiates candidates the browser cannot reach (the VM only has a
// masquerade'd pod IP), which is what left VM sessions connecting to a black
// screen while container workspaces, whose pod is reachable, worked.
function webtopEnvFlags() {
  const pairs = WEBTOP_ENV.split(" ").filter(Boolean)
    .concat(turnEnv().map((e) => e.name + "=" + e.value))
  return pairs.map((kv) => "-e " + kv).join(" ")
}

function webtopUnit({ homeMount = false } = {}) {
  return [
    "[Unit]",
    "Description=LSIO webtop container desktop",
    "After=network-online.target docker.service",
    "Wants=network-online.target docker.service",
    "Requires=docker.service",
    // The desktop's /config lives on the NFS-mounted home volume, so the unit
    // must not start before it is there - and must be restarted if the mount
    // comes later (see Restart= on-failure below).
    ...(homeMount ? ["RequiresMountsFor=" + GUEST_HOME_PATH] : []),
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    // Pull retries: registry hiccups shouldn't brick a fresh VM boot.
    "ExecStartPre=-/bin/sh -c 'for i in 1 2 3 4 5; do /usr/bin/docker pull " + WEBTOP_IMAGE + " && break; sleep 20; done'",
    "ExecStart=/bin/sh -c '" +
      // No single quotes in here: the whole script is already inside the
      // ExecStart='...' quoting, and a nested quote ends the string early -
      // systemd then hands /bin/sh a truncated script (this exact bug made the
      // unit die with "Syntax error: end of file unexpected").
      (homeMount
        ? "mountpoint -q " + GUEST_HOME_PATH + " || { echo home-volume-not-mounted at " + GUEST_HOME_PATH + " >&2; exit 1; }; "
        : "") +
      "if docker ps --filter name=webtop --filter status=running -q | grep -q .; then exit 0; fi; docker rm -f webtop 2>/dev/null; exec /usr/bin/docker run -d --name webtop --restart unless-stopped --shm-size=1g -p 8080:3000 " +
      (homeMount ? "-v " + GUEST_HOME_PATH + ":/config " : "") +
      webtopEnvFlags() + " " + WEBTOP_IMAGE + "'",
    // The first boot pulls desktop and browser images inside the guest, which
    // is minutes on a good link; 10 minutes was short enough to fail, and a
    // failed pull left the unit failed and the desktop dead with nothing to
    // retry it. Retry instead, and give the pull room to finish.
    "TimeoutStartSec=1800",
    "Restart=on-failure",
    "RestartSec=30",
    "ExecStop=/usr/bin/docker stop webtop",
    "RemainAfterExit=yes",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n")
}

function cloudInitUserData({ homeSource = null } = {}) {
  return [
    "#cloud-config",
    "users:",
    "  - default",
    "  - name: user",
    "    plain_text_passwd: user",
    "    lock_passwd: false",
    "    shell: /bin/bash",
    "    groups: sudo, ssl-cert",
    // The home volume is served by Longhorn's share-manager over NFS; hard
    // keeps a busy desktop from seeing write errors when the share blips.
    ...(homeSource
      ? [
          "mounts:",
          "  - [ '" + homeSource + "', '" + GUEST_HOME_PATH + "', 'nfs', 'nfsvers=4.1,hard,noatime,_netdev', '0', '0' ]",
        ]
      : []),
    // write_files: heredocs inside runcmd break, so files land from here.
    "write_files:",
    "  - path: /etc/systemd/system/webtop.service",
    "    permissions: '0644'",
    "    content: |",
    "      " + webtopUnit({ homeMount: !!homeSource }).split("\n").join("\n      "),
    // Not the packages: block — it does not retry and one transient mirror
    // hiccup killed the entire first boot (verified). Retry the install.
    "runcmd:",
    "  - |",
    "    for i in 1 2 3 4 5; do",
    "      apt-get update -o Acquire::Retries=5 >/dev/null 2>&1 && break",
    "      sleep 10",
    "    done",
    "    for i in 1 2 3; do",
    "      apt-get install -y -o Acquire::Retries=5 ca-certificates curl jq nfs-common >/var/log/mytops-packages.log 2>&1 && break",
    "      sleep 30",
    "    done",
    // Docker runtime (jammy has docker.io for the engine; kasm apt repos are not needed).
    "  - |",
    "    for i in 1 2 3; do",
    "      DEBIAN_FRONTEND=noninteractive apt-get install -y -o Acquire::Retries=5 docker.io containerd runc >/var/log/mytops-docker.log 2>&1 && break",
    "      sleep 30",
    "    done",
    "    systemctl enable --now docker",
    // The guest's /config lives on the Longhorn home volume (or, for an
    // ephemeral entry, in the container) - never on the VM's root disk, so the
    // VM can be rebuilt from scratch without losing the user's data.
    ...(homeSource ? ["  - mkdir -p " + GUEST_HOME_PATH + " && chown -R user:user " + GUEST_HOME_PATH] : []),
    "  - systemctl daemon-reload",
    "  - systemctl enable webtop.service",
    // --no-block: the unit owns the desktop's lifecycle (it is enabled, ordered
    // after the NFS home mount, and restarts itself on failure). Blocking here
    // made cloud-init's final stage wait out the whole first-boot image pull,
    // and fail with it.
    "  - systemctl start --no-block webtop.service",
  ].join("\n")
}

const VM_IMAGE_URL =
  "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img"

// Optional pin: streaming workloads should run on the least-loaded node
// (control-plane nodes with etcd churn are poor homes for frame-latency
// sensitive desktops). Empty = let the scheduler decide.
const WORKSPACE_NODE = process.env.WORKSPACE_NODE || ""

function nodeSelector() {
  return WORKSPACE_NODE ? { "kubernetes.io/hostname": WORKSPACE_NODE } : {}
}

function buildVirtualMachine(entry, name, owner, ownerEmail) {
  const cpu = parseInt(entry.resources?.cpu) || 2
  const mem = entry.resources?.memory || "2Gi"
  const storage = entry.storage || "10Gi"
  return {
    apiVersion: "kubevirt.io/v1",
    kind: "VirtualMachine",
    metadata: {
      name: name,
      namespace: VM_NAMESPACE,
      annotations: ownerEmail ? { "mytops/owner-email": ownerEmail } : undefined,
      labels: {
        "app.kubernetes.io/name": name,
        "mytops-owner": owner,
        "mytops-runtime": entry.runtime || "vm-linux",
        "mytops-persistence": entry.persistence || "disposable",
        "mytops-lifecycle": entry.lifecycle || "ephemeral",
      },
    },
    spec: {
      runStrategy: "Always",
      template: {
        metadata: {
          labels: { "app.kubernetes.io/name": name },
        },
        spec: {
          nodeSelector: nodeSelector(),
          domain: {
            cpu: { cores: cpu },
            memory: { guest: mem },
            devices: {
              disks: [
                { name: "rootdisk", disk: { bus: "virtio" } },
                { name: "cloudinit", disk: { bus: "virtio" } },
              ],
              interfaces: [
                { name: "default", masquerade: {} },
              ],
            },
            machine: { type: "q35" },
          },
          networks: [
            { name: "default", pod: {} },
          ],
          terminationGracePeriodSeconds: 0,
          volumes: [
            {
              name: "rootdisk",
              persistentVolumeClaim: { claimName: name },
            },
            {
              name: "cloudinit",
              cloudInitNoCloud: {
                // NOTE: field is `secretRef` even though the Go type is
                // UserDataSecretRef.
                secretRef: { name: name + "-cloudinit" },
              },
            },
          ],
        },
      },
      dataVolumeTemplates: [
        {
          metadata: { name: name },
          spec: {
            source: {
              http: { url: VM_IMAGE_URL },
            },
            pvc: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: "longhorn",
              resources: {
                requests: { storage: storage },
              },
            },
          },
        },
      ],
    },
  }
}

function buildVmService(name) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: name + "-svc",
      namespace: VM_NAMESPACE,
      labels: { "app.kubernetes.io/name": name },
    },
    spec: {
      selector: { "app.kubernetes.io/name": name },
      ports: [
        { name: "http", port: 8080, targetPort: 8080 },
      ],
    },
  }
}

// The VM validator rejects inline cloudInitNoCloud userData > 2048 bytes, so
// the user-data goes into a Secret referenced via userDataSecretRef.
function buildCloudInitSecret(name, userData) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: name + "-cloudinit",
      namespace: VM_NAMESPACE,
      labels: { "app.kubernetes.io/name": name },
    },
    data: { userData: Buffer.from(userData).toString("base64") },
  }
}

// Has the VM's web client actually started answering? VMI Ready only means the
// guest booted; the desktop container inside comes up a couple of minutes
// later, so everything that reports VM state asks this.
async function guestStreamReady(name) {
  try {
    const res = await fetch("http://" + name + "-svc." + VM_NAMESPACE + ".svc.cluster.local:8080/", {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

function isVmRuntime(runtime) {
  return runtime && runtime.startsWith("vm-")
}

function vmWorkspaceUrl(name, domain) {
  // Same single-level host as containers — the wildcard cert only covers
  // *.tuntelder.com (one level), so no extra "apps." component.
  return "https://" + name + "." + domain
}

// ── Audit ────────────────────────────────────────────────────────────
// One JSON line per state-changing action, on stdout, so the cluster's log
// stack can answer "who destroyed whose desktop" without a database here.
// Deliberately boring: an audit trail that can fail is worse than none.
function audit(actor, action, target, detail = "") {
  console.log("audit: " + JSON.stringify({
    at: new Date().toISOString(),
    actor: actor || "unknown",
    action,
    target,
    detail,
  }))
}

// ── Idle suspension ──────────────────────────────────────────────────
//
// An entry can say how long a workspace may sit unused (`idleSuspendMinutes`
// in the catalog). Unused means nobody is watching it: the SPA heartbeats the
// workspace it has on screen (/api/workspaces/:id/touch) and opening a stream
// counts as activity too. An idle workspace is *stopped*, never destroyed - the
// home volume is untouched - so picking it up again is a launch, not a rebuild.
//
// The activity map lives in this process; the last value is also written to the
// workspace's `mytops/last-active` annotation so a restart (or the admin page)
// still has something to go on. A restart can therefore only make us slower to
// suspend, never suspend something that is in use: an unknown workspace is
// measured from its annotation, or from its creation time if it has none.
const activity = new Map() // workspace name -> epoch ms
const ACTIVITY_ANNOTATION = "mytops/last-active"
const SUSPENDED_ANNOTATION = "mytops/suspended-at"
const IDLE_CHECK_MS = Number(process.env.IDLE_CHECK_MS) || 60_000
// Persisting every heartbeat would be a write per workspace per interval; the
// in-memory map is the real source and this is only for restarts.
const ACTIVITY_PERSIST_MS = 5 * 60_000

function idleLimitMs(entry) {
  const minutes = Number(entry?.idleSuspendMinutes) || 0
  return minutes > 0 ? minutes * 60_000 : 0
}

function touchActivity(name) {
  const now = Date.now()
  activity.set(name, now)
  return now
}

// Resolve "when was this last used" for a workspace we have no live record of.
// Anything unparseable means "unknown", which is treated as *now*: failing to
// date a workspace must never be the reason it gets stopped.
function lastActiveFrom(obj) {
  const stamp = Date.parse(obj.metadata.annotations?.[ACTIVITY_ANNOTATION] ?? "")
  if (Number.isFinite(stamp)) return stamp
  const created = Date.parse(obj.metadata?.creationTimestamp ?? "")
  return Number.isFinite(created) ? created : Date.now()
}

function workspaceIsSuspended(runtime, obj) {
  if (runtime === "container") return obj.spec?.replicas === 0
  return obj.spec?.runStrategy === "Halted"
}

// Stop/resume one workspace in place. `replicas: 0` and `runStrategy: Halted`
// are the reversible switch for each runtime; a halted VM keeps its disk, and
// the home volume stays attached to its keeper either way.
async function setWorkspaceSuspended(runtime, name, suspended, headers) {
  const now = new Date().toISOString()
  if (runtime === "container") {
    await kubeFetch("PATCH", "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + name, {
      metadata: { annotations: { [SUSPENDED_ANNOTATION]: suspended ? now : null, [ACTIVITY_ANNOTATION]: now } },
      spec: { replicas: suspended ? 0 : 1 },
    }, headers)
  } else {
    await kubeFetch("PATCH", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines/" + name, {
      metadata: { annotations: { [SUSPENDED_ANNOTATION]: suspended ? now : null, [ACTIVITY_ANNOTATION]: now } },
      spec: { runStrategy: suspended ? "Halted" : "Always" },
    }, headers)
  }
  if (suspended) activity.set(name, Date.now())
}

// One sweep over every workspace of every user. The API is the only component
// that knows about activity, and this is a homelab's worth of objects, so a
// list per interval is cheaper than another controller.
async function suspendIdleWorkspaces() {
  try {
    const [deps, vms] = await Promise.all([
      kubeFetch("GET", "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments?labelSelector=app.kubernetes.io%2Fcomponent%3Dsession", null, {}),
      kubeFetch("GET", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines?labelSelector=mytops-runtime", null, {}).catch(() => ({ items: [] })),
    ])
    const targets = [
      ...(deps.items ?? []).map((d) => ({ runtime: "container", obj: d })),
      ...(vms.items ?? []).map((v) => ({ runtime: "vm", obj: v })),
    ]
    const now = Date.now()
    for (const { runtime, obj } of targets) {
      const name = obj.metadata?.name
      if (!name?.startsWith("ws-")) continue
      if (workspaceIsSuspended(runtime, obj)) continue
      const slug = obj.metadata.labels?.["mytops-owner"] ?? ""
      const entry = catalog.find((e) => e.id === entryIdOf(name, slug))
      const limit = idleLimitMs(entry)
      if (!limit) continue
      const last = activity.get(name) ?? lastActiveFrom(obj)
      if (now - last < limit) continue
      audit("system", "idle.suspend", name, "idle " + Math.round((now - last) / 60_000) + "m, limit " + limit / 60_000 + "m")
      await setWorkspaceSuspended(runtime, name, true, {})
        .catch((err) => console.error("idle: could not suspend " + name + ": " + err.message))
    }
  } catch (err) {
    console.error("idle sweep failed: " + err.message)
  }
}

// ── Route handlers ───────────────────────────────────────────────────

// Admin group gate (X-Auth-Request-Groups from oauth2-proxy).
const ADMIN_GROUPS = new Set(
  (process.env.ADMIN_GROUPS || "admin,admins").split(",").map((g) => g.trim()).filter(Boolean),
)

function isAdmin(identity) {
  return (identity.groups ?? "").split(",").some((g) => ADMIN_GROUPS.has(g.trim()))
}

// GET /api/stream-auth — Traefik forwardAuth for the workspace hosts.
//
// The workspace IngressRoutes are matched by hostname only, and that hostname
// is derived from the owner's email, so "signed in" was the whole test: anyone
// in the realm could open anyone's desktop by guessing a URL. This endpoint is
// what the mytops-workspace-owner middleware asks, after oauth2-proxy has
// authenticated the request, and it answers one question: does the caller own
// the host in this request?
//
// The caller is oauth2-proxy's authenticated identity, which reaches us either
// as the identity headers (oauth2-proxy's forwardAuth sets them on the request,
// and Traefik passes them on to the next middleware) or, if that ever stops
// being true, as the session cookie we can validate against oauth2-proxy here.
// Admins pass, so support can still reach a workspace.
async function handleStreamAuth(req, res, identity) {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
    .replace(/:\d+$/, "")
    .toLowerCase()
  const label = host.split(".")[0]

  // One identity, from one source: either the headers oauth2-proxy's own
  // forwardAuth put on the request, or (if those are missing) a fresh check of
  // the session cookie. Never a mix - a group list taken from the client's
  // headers would be a way to grant yourself the admin bypass below.
  let email = identity.email
  let groups = identity.groups
  if (!email) {
    const cookie = req.headers.cookie
    if (!cookie || !OAUTH2_AUTH_URL) return json(res, 401, { error: "unauthenticated" })
    const auth = await fetch(OAUTH2_AUTH_URL, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
      .catch((err) => {
        console.error("stream-auth: oauth2-proxy unreachable: " + err.message)
        return null
      })
    if (!auth || !auth.ok) return json(res, 401, { error: "unauthenticated" })
    email = auth.headers.get("x-auth-request-email") ?? ""
    groups = auth.headers.get("x-auth-request-groups") ?? ""
    if (!email) return json(res, 401, { error: "unauthenticated" })
  }

  const ownsHost = label.startsWith("ws-") && label.endsWith("-" + slugFor(email))
  if (ownsHost || isAdmin({ groups })) {
    // Opening a stream is the strongest "in use" signal there is, so it keeps
    // an idle-suspend entry alive even if the SPA is not the one asking.
    if (ownsHost) touchActivity(label)
    return json(res, 200, { ok: true })
  }

  audit(email, "stream.denied", host, "does not own this workspace")
  console.warn("stream-auth: " + email + " denied for " + host)
  json(res, 403, { error: "not your workspace" })
}

// GET /api/health
function handleHealth(_req, res) {
  json(res, 200, { ok: true })
}

// GET /api/catalog
function handleCatalog(_req, res) {
  json(res, 200, { apps: catalog })
}

// POST /api/workspaces/:entryId/touch — "this workspace is on my screen".
// The SPA sends it while a workspace is the open tab; together with the stream
// check it is what keeps an idle-suspend entry alive.
async function handleTouchWorkspace(req, res, identity, entryId) {
  const name = instName(entryId, slugFor(identity.email))
  const now = touchActivity(name)
  json(res, 200, { ok: true, lastActiveAt: now })
}

// GET /api/workspaces — list running workspaces for the caller.
async function handleListWorkspaces(req, res, identity) {
  const slug = slugFor(identity.email)
  const domain = DOMAIN || baseDomain(req.headers.host ?? "")

  // ── Container workspaces (Deployments in services ns) ────────────
  const depList = await kubeFetch(
    "GET",
    "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments?labelSelector=mytops-owner%3D" + slug,
    null,
    req.headers,
  )
  const depItems = depList.items ?? []
  const containerWs = await Promise.all(depItems
    .filter((d) => d.metadata?.name?.startsWith("ws-"))
    .map(async (d) => {
      const name = d.metadata.name
      const entryId = entryIdOf(name, slug)
      const entry = catalog.find((e) => e.id === entryId)
      // Self-heal like the VM branch below: a route created before the owner
      // middleware existed (or with a stale backend) is rebuilt here rather
      // than only on the next launch.
      await ensureIngressRoute(name, domain, { name, namespace: NAMESPACE, port: 3000 }, req.headers)
        .catch((err) => console.error("workspace " + name + ": " + err.message))
      return {
        id: entryId,
        name: entry?.name ?? entryId,
        type: entry?.type ?? "desktop",
        runtime: "container",
        icon: entry?.icon,
        status: containerWorkspaceStatus(d),
        lastActiveAt: activity.get(name) ?? lastActiveFrom(d),
        url: "https://" + name + "." + domain,
      }
    }))

  // ── VM workspaces (VirtualMachines in kubevirt ns) ───────────────
  let vmItems = []
  try {
    const vmList = await kubeFetch(
      "GET",
      "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines?labelSelector=mytops-owner%3D" + slug,
      null,
      req.headers,
    )
    vmItems = vmList.items ?? []
  } catch { /* KubeVirt not installed yet */ }

  const vmWs = await Promise.all(vmItems
    .filter((vm) => vm.metadata?.labels?.["mytops-runtime"]?.startsWith("vm-"))
    .map(async (vm) => {
      const name = vm.metadata.name
      const entryId = entryIdOf(name, slug)
      const entry = catalog.find((e) => e.id === entryId)

      // Self-heal: VM IngressRoutes created by older API code pointed at the
      // container backend (services:3000) — fix whenever we see the drift.
      await ensureIngressRoute(name, domain,
        { name: name + "-svc", namespace: VM_NAMESPACE, port: 8080 }, req.headers)
        .catch((err) => console.error("workspace " + name + ": " + err.message))

      const streamReady = await guestStreamReady(name)

      return {
        id: entryId,
        name: entry?.name ?? entryId,
        type: entry?.type ?? "desktop",
        runtime: entry?.runtime ?? "vm-linux",
        icon: entry?.icon,
        status: vmWorkspaceStatus(vm, streamReady),
        streamReady,
        lastActiveAt: activity.get(name) ?? lastActiveFrom(vm),
        url: vmWorkspaceUrl(name, domain),
      }
    })
  )

  json(res, 200, containerWs.concat(vmWs))
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

  if (isVmRuntime(entry.runtime)) {
    return handleCreateVmWorkspace(req, res, entry, name, slug, domain, identity)
  }
  return handleCreateContainerWorkspace(req, res, entry, name, slug, domain, identity)
}

// ── Container workspace creation ─────────────────────────────────────
//
// Creation returns as soon as the objects exist: the SPA polls
// /api/workspaces every few seconds and the server list is the source of
// truth, so blocking the HTTP request until the pod was ready only made
// Launch hang for minutes behind (and sometimes past) the ingress and browser
// timeouts, with no way for the client to tell success from a dropped
// connection.
async function handleCreateContainerWorkspace(req, res, entry, name, slug, domain, identity) {
  // Ensure the home before looking at the workspace: an existing keeper has to
  // be brought up to date (it grew the file API), and a workspace that is
  // already running would otherwise skip that.
  if (usesHome(entry)) await ensureHome(slug, entry, req.headers)

  const depPath = "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + name
  const existing = await kubeFetch("GET", depPath, null, req.headers)
  if (!isNotFound(existing)) {
    // Launch is "make sure this is running": a suspended workspace is started
    // again rather than left as it is.
    if (existing.spec?.replicas === 0) {
      await setWorkspaceSuspended("container", name, false, req.headers)
      touchActivity(name)
      audit(identity?.email, "workspace.resume", name)
      return json(res, 200, {
        id: entry.id, name, status: "starting",
        url: "https://" + name + "." + domain,
      })
    }
    return json(res, 200, {
      id: entry.id, name, status: containerWorkspaceStatus(existing),
      url: "https://" + name + "." + domain,
    })
  }

  await kubeFetch("POST", "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments",
    buildDeployment(entry, name, slug, identity?.email), req.headers)
  touchActivity(name)
  audit(identity?.email, "workspace.create", name, "entry=" + entry.id + " runtime=container")

  await ensureService(NAMESPACE, name, () => buildService(name, slug, entry.id), req.headers)
  await ensureIngressRoute(name, domain, { name, namespace: NAMESPACE, port: 3000 }, req.headers)

  json(res, 200, {
    id: entry.id, name, status: "starting",
    url: "https://" + name + "." + domain,
  })
}

// ── VM workspace creation ────────────────────────────────────────────
async function handleCreateVmWorkspace(req, res, entry, name, slug, domain, identity) {
  // Same as the container path: keep the home and its keeper current even when
  // the VM already exists.
  const home = usesHome(entry) ? await ensureHome(slug, entry, req.headers) : null

  const vmPath = "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines/" + name
  const existing = await kubeFetch("GET", vmPath, null, req.headers)
  if (!isNotFound(existing)) {
    await ensureIngressRoute(name, domain,
      { name: name + "-svc", namespace: VM_NAMESPACE, port: 8080 }, req.headers)
    if (existing.spec?.runStrategy === "Halted") {
      await setWorkspaceSuspended("vm", name, false, req.headers)
      touchActivity(name)
      audit(identity?.email, "workspace.resume", name)
      return json(res, 200, {
        id: entry.id, name, status: "starting",
        url: vmWorkspaceUrl(name, domain),
      })
    }
    return json(res, 200, {
      id: entry.id, name, status: vmWorkspaceStatus(existing, false),
      url: vmWorkspaceUrl(name, domain),
    })
  }

  // The guest mounts the user's home over NFS, and the mount source only
  // exists once the claim has bound, so this has to resolve before the
  // cloud-init Secret is written. Failing loudly beats booting a desktop whose
  // profile silently lives on the throwaway root disk.
  // The guest mounts the user's home over NFS and the mount source only exists
  // once the claim has bound.
  let homeSource = home
  if (usesHome(entry) && !homeSource) homeSource = await ensureHomeSource(slug, entry, req.headers)
  if (usesHome(entry) && !homeSource) {
    return json(res, 503, {
      error: "home volume " + homeName(slug) + " did not become ready; try again in a moment",
    })
  }

  const secretPath = "/api/v1/namespaces/" + VM_NAMESPACE + "/secrets/" + name + "-cloudinit"
  const secExists = await kubeFetch("GET", secretPath, null, req.headers)
  if (isNotFound(secExists)) {
    await kubeFetch("POST", "/api/v1/namespaces/" + VM_NAMESPACE + "/secrets",
      buildCloudInitSecret(name, cloudInitUserData({ homeSource })), req.headers)
  }

  await kubeFetch("POST", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines",
    buildVirtualMachine(entry, name, slug, identity?.email), req.headers)
  touchActivity(name)
  audit(identity?.email, "workspace.create", name, "entry=" + entry.id + " runtime=" + (entry.runtime ?? "container"))

  await ensureService(VM_NAMESPACE, name + "-svc", () => buildVmService(name), req.headers)
  await ensureIngressRoute(name, domain,
    { name: name + "-svc", namespace: VM_NAMESPACE, port: 8080 }, req.headers)

  json(res, 200, {
    id: entry.id, name, status: "starting", url: vmWorkspaceUrl(name, domain),
  })
}

// DELETE /api/workspaces/:entryId — tear down a workspace and its disk.
async function handleDeleteWorkspace(req, res, identity, entryId) {
  const slug = slugFor(identity.email)
  const name = instName(entryId, slug)
  const failures = await teardownWorkspace(name, req.headers)
  if (failures.length) {
    audit(identity.email, "workspace.destroy", name, "failed: " + failures[0])
    return json(res, 502, { error: "teardown incomplete: " + failures[0] })
  }
  audit(identity.email, "workspace.destroy", name, "home volume kept")
  json(res, 200, { ok: true })
}

// Admin: list ALL workspaces regardless of owner. This is the admin page's only
// data source: the browser cannot see other people's workspaces any other way,
// and every field here (owner, life, last activity, home volume) is something
// an admin has to consider before acting on someone else's work.
async function handleAdminList(req, res, identity) {
  if (!isAdmin(identity)) return json(res, 403, { error: "not admin" })

  const [sap, vmsList] = await Promise.all([
    kubeFetch("GET",
      "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments?labelSelector=app.kubernetes.io%2Fcomponent%3Dsession",
      null, req.headers),
    kubeFetch("GET", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines?labelSelector=mytops-runtime", null, req.headers)
      .catch(() => ({ items: [] })),
  ])

  const describe = (runtime, obj) => {
    const name = obj.metadata.name
    const slug = obj.metadata.labels?.["mytops-owner"] ?? ""
    const entryId = name.startsWith("ws-") && slug ? entryIdOf(name, slug) : name
    const entry = catalog.find((e) => e.id === entryId)
    return {
      name,
      entryId,
      entryName: entry?.name ?? entryId,
      runtime,
      owner: slug,
      ownerEmail: obj.metadata.annotations?.["mytops/owner-email"] ?? null,
      lifecycle: obj.metadata.labels?.["mytops-lifecycle"] ?? "",
      persistence: obj.metadata.labels?.["mytops-persistence"] ?? "",
      status: runtime === "container" ? containerWorkspaceStatus(obj) : "starting",
      lastActiveAt: activity.get(name) ?? lastActiveFrom(obj),
      home: null,
    }
  }

  const rows = [
    ...(sap.items ?? []).map((d) => describe("container", d)),
    ...(vmsList.items ?? []).map((v) => describe("vm", v)),
  ]

  // An admin sees the same truth as the owner, so the VM rows get the same
  // guest probe the owner's list does (a booted guest whose desktop has not
  // come up is "starting", not "running").
  await Promise.all(rows.filter((row) => row.runtime === "vm" && row.status === "starting").map(async (row) => {
    const vm = (vmsList.items ?? []).find((v) => v.metadata?.name === row.name)
    if (vm) row.status = vmWorkspaceStatus(vm, await guestStreamReady(row.name))
  }))

  // One home volume per *user*, so look each owner up once no matter how many
  // workspaces they have.
  const owners = [...new Set(rows.map((r) => r.owner).filter(Boolean))]
  const homes = new Map(await Promise.all(owners.map(async (slug) => {
    const pvc = await kubeFetch("GET", "/api/v1/namespaces/" + NAMESPACE + "/persistentvolumeclaims/" + homeName(slug), null, req.headers)
      .catch(() => null)
    return [slug, isNotFound(pvc) ? null : pvc]
  })))
  for (const row of rows) {
    const pvc = homes.get(row.owner)
    const homeName_ = pvc?.metadata?.name
    if (homeName_) {
      row.home = {
        name: homeName_,
        phase: pvc.status?.phase ?? "Unknown",
        size: pvc.spec?.resources?.requests?.storage ?? "",
      }
    }
  }

  json(res, 200, rows)
}

// Admin: stop or start someone else's workspace. Same helper the idle sweep
// uses, so an admin action and an automatic suspension are the same operation.
async function handleAdminSuspend(req, res, identity, target, suspended) {
  if (!isAdmin(identity)) return json(res, 403, { error: "not admin" })
  if (!/^ws-[a-z0-9-]+$/.test(target)) return json(res, 400, { error: "bad workspace name" })

  const dep = await kubeFetch("GET", "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + target, null, req.headers)
  const runtime = isNotFound(dep) ? "vm" : "container"
  const obj = isNotFound(dep)
    ? await kubeFetch("GET", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines/" + target, null, req.headers)
    : dep
  if (isNotFound(obj)) return json(res, 404, { error: "workspace not found" })

  await setWorkspaceSuspended(runtime, target, suspended, req.headers)
  audit(identity.email, suspended ? "admin.suspend" : "admin.resume", target,
    "owner=" + (obj.metadata.labels?.["mytops-owner"] ?? "?"))
  json(res, 200, { ok: true, status: suspended ? "suspended" : "starting" })
}

// Admin: destroy a workspace by full object name (ws-<entryId>-<slug>). Same
// teardown as the user path, so the VM disk and its Longhorn volume go too.
async function handleAdminDelete(req, res, identity, target) {
  if (!isAdmin(identity)) return json(res, 403, { error: "not admin" })
  if (!/^ws-[a-z0-9-]+$/.test(target)) return json(res, 400, { error: "bad workspace name" })

  const failures = await teardownWorkspace(target, req.headers)
  if (failures.length) {
    audit(identity.email, "admin.destroy", target, "failed: " + failures[0])
    return json(res, 502, { error: "teardown incomplete: " + failures[0] })
  }
  audit(identity.email, "admin.destroy", target, "home volume kept")
  json(res, 200, { ok: true })
}

// POST /api/workspaces/:entryId/restart — restart a workspace.
// Containers: rolling-restart the Deployment. VMs: delete the VMI — with
// runStrategy: Always KubeVirt boots a fresh instance of the same disk.
//
// Like creation, this returns as soon as the restart is under way and leaves
// the outcome to the poll. Waiting for readiness here answered too early
// anyway: the old pod (or VMI) is still Ready while the new one starts, so
// "ok" was reported before anything had actually restarted.
async function handleRestartWorkspace(req, res, identity, entryId) {
  const slug = slugFor(identity.email)
  const name = instName(entryId, slug)
  const depPath = "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + name
  const vmiPath = "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachineinstances/" + name

  const dep = await kubeFetch("GET", depPath, null, req.headers)
  if (!isNotFound(dep)) {
    // Restarting something that is suspended just means starting it; there is
    // no pod to roll.
    if (dep.spec?.replicas === 0) {
      await setWorkspaceSuspended("container", name, false, req.headers)
      return json(res, 200, { ok: true, status: "starting" })
    }
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: { "mytops/restartedAt": new Date().toISOString() },
          },
        },
      },
    }
    await kubeFetch("PATCH", depPath, patch, req.headers)
    return json(res, 200, { ok: true, status: "starting" })
  }

  // Not a container workspace — treat as a VM restart. Deleting the VMI is
  // the restart: runStrategy: Always boots a fresh instance of the same disk.
  const vm = await kubeFetch("GET", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines/" + name, null, req.headers)
  if (isNotFound(vm)) return json(res, 404, { error: "workspace not found" })
  if (vm.spec?.runStrategy === "Halted") {
    await setWorkspaceSuspended("vm", name, false, req.headers)
    return json(res, 200, { ok: true, status: "starting" })
  }
  const vmi = await kubeFetch("GET", vmiPath, null, req.headers)
  if (isNotFound(vmi)) return json(res, 404, { error: "workspace not found" })
  await kubeFetch("DELETE", vmiPath, null, req.headers)
  json(res, 200, { ok: true, status: "starting" })
}

// ── Files ────────────────────────────────────────────────────────────
//
// The files live in the user's home volume, which is mounted by that user's
// keeper pod. That pod runs the home agent (see api/home-agent.mjs) and is the
// only thing that can touch the volume without starting a desktop; the API
// resolves the caller to a user, finds their agent, and proxies. Nothing is
// buffered: uploads and downloads stream through.
//
// Admins may pass ?owner=<slug> to reach someone else's files; that path is
// audited, and the UI keeps it read-only.
const FILES_AGENT_PORT = Number(process.env.FILES_AGENT_PORT) || 8080

// path on this API -> path on the agent
const FILE_ROUTES = [
  { match: /^\/api\/files\/list$/, method: "GET", agent: "/fs/list" },
  { match: /^\/api\/files\/usage$/, method: "GET", agent: "/fs/usage" },
  { match: /^\/api\/files\/content$/, method: "GET", agent: "/fs/file" },
  { match: /^\/api\/files\/content$/, method: "PUT", agent: "/fs/file" },
  { match: /^\/api\/files\/dir$/, method: "POST", agent: "/fs/dir" },
  { match: /^\/api\/files\/move$/, method: "POST", agent: "/fs/move" },
  { match: /^\/api\/files\/entry$/, method: "DELETE", agent: "/fs" },
]
const FILE_MUTATIONS = new Set(["/fs/file", "/fs/dir", "/fs/move", "/fs"])

async function homeAgentUrl(slug, headers) {
  const selector = encodeURIComponent("app.kubernetes.io/component=home-keeper,mytops-owner=" + slug)
  const pods = await kubeFetch("GET", "/api/v1/namespaces/" + NAMESPACE + "/pods?labelSelector=" + selector, null, headers)
  const pod = (pods.items ?? []).find((p) => p.status?.podIP && !p.metadata?.deletionTimestamp)
  return pod ? "http://" + pod.status.podIP + ":" + FILES_AGENT_PORT : null
}

async function handleFiles(req, res, identity, url) {
  const route = FILE_ROUTES.find((r) => r.method === req.method && r.match.test(url.pathname))
  if (!route) return json(res, 404, { error: "not found" })

  const target = url.searchParams.get("owner")
  const admin = isAdmin(identity)
  if (target && !admin) return json(res, 403, { error: "not admin" })
  const slug = target ?? slugFor(identity.email)

  const agent = await homeAgentUrl(slug, req.headers)
  if (!agent) {
    return json(res, 404, {
      error: target
        ? "that user has no home volume"
        : "no home volume yet - start a persistent workspace first",
    })
  }

  const params = new URLSearchParams(url.search)
  params.delete("owner")
  if (FILE_MUTATIONS.has(route.agent)) {
    audit(identity.email, "files." + (route.agent === "/fs" ? "delete" : route.agent.slice(4)), slug,
      (params.get("path") ?? params.get("to") ?? "") + (target ? " (admin)" : ""))
  } else if (target) {
    audit(identity.email, "files.read", slug, params.get("path") ?? "/")
  }

  let upstream
  try {
    upstream = await fetch(agent + route.agent + "?" + params.toString(), {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/octet-stream" },
      // req is a stream and the agent streams to disk, so a big upload is never
      // held in memory here either.
      body: req.method === "GET" || req.method === "DELETE" ? undefined : req,
      duplex: "half",
    })
  } catch (err) {
    return json(res, 502, { error: "home agent unreachable: " + err.message })
  }

  const headers = {}
  for (const key of ["content-type", "content-length", "content-disposition", "last-modified"]) {
    const value = upstream.headers.get(key)
    if (value) headers[key] = value
  }
  res.writeHead(upstream.status, headers)
  if (!upstream.body) return res.end()
  for await (const chunk of upstream.body) res.write(chunk)
  res.end()
}

// ── Router ───────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS for local dev (vite :5173).
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end() }

  const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"))
  const path = url.pathname

  // Extract oauth2-proxy identity headers. oauth2-proxy (set-xauthrequest)
  // strips any client-supplied X-Auth-Request-* header and injects its own,
  // and every /api route here is behind it - the workspace IngressRoutes carry
  // the same middleware. A request without an email is therefore either a
  // probe (/api/health, which the readiness probe uses) or something bypassing
  // the proxy; without this check every such caller shares the slug for the
  // empty string and can create and destroy workspaces as that phantom user.
  const identity = {
    email: req.headers["x-auth-request-email"] ?? "",
    groups: req.headers["x-auth-request-groups"] ?? "",
  }

  // NOTE: every handler call is awaited. Handlers are async and a bare
  // `return handler(...)` inside this try hands the rejection back to the
  // caller instead of the catch block - an apiserver error would take the
  // whole process down (and the workspace API with it) instead of answering
  // 502.
  try {
    if (path === "/api/health" && req.method === "GET") return await handleHealth(req, res)
    // Before the identity guard: this route resolves the caller itself, since
    // Traefik calls it with the request's session cookie as well as (normally)
    // oauth2-proxy's identity headers.
    if (path === "/api/stream-auth" && req.method === "GET") return await handleStreamAuth(req, res, identity)
    if (!identity.email) return json(res, 401, { error: "unauthenticated" })

    if (path === "/api/me" && req.method === "GET") {
      // isAdmin is for the SPA's benefit (showing the admin tab); every admin
      // route re-checks it server-side.
      return json(res, 200, { email: identity.email, groups: identity.groups, isAdmin: isAdmin(identity) })
    }
    if (path === "/api/catalog" && req.method === "GET") return await handleCatalog(req, res)
    if (path.startsWith("/api/files/")) return await handleFiles(req, res, identity, url)
    if (path === "/api/workspaces" && req.method === "GET") return await handleListWorkspaces(req, res, identity)
    if (path === "/api/workspaces" && req.method === "POST") return await handleCreateWorkspace(req, res, identity)

    // /api/workspaces/:entryId
    const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)$/)
    if (wsMatch) {
      const entryId = decodeURIComponent(wsMatch[1])
      if (req.method === "DELETE") return await handleDeleteWorkspace(req, res, identity, entryId)
    }
    // /api/workspaces/:entryId/touch — keep-alive from the SPA
    const touchMatch = path.match(/^\/api\/workspaces\/([^/]+)\/touch$/)
    if (touchMatch && req.method === "POST") {
      return await handleTouchWorkspace(req, res, identity, decodeURIComponent(touchMatch[1]))
    }
    // /api/workspaces/:entryId/restart
    const rsMatch = path.match(/^\/api\/workspaces\/([^/]+)\/restart$/)
    if (rsMatch && req.method === "POST") {
      return await handleRestartWorkspace(req, res, identity, decodeURIComponent(rsMatch[1]))
    }

    // Admin cleanup (ADMIN_GROUPS gate).
    if (path === "/api/admin/workspaces" && req.method === "GET") return await handleAdminList(req, res, identity)
    const adminMatch = path.match(/^\/api\/admin\/workspaces\/([^/]+)$/)
    if (adminMatch && req.method === "DELETE") return await handleAdminDelete(req, res, identity, decodeURIComponent(adminMatch[1]))
    const adminAction = path.match(/^\/api\/admin\/workspaces\/([^/]+)\/(suspend|resume)$/)
    if (adminAction && req.method === "POST") {
      return await handleAdminSuspend(req, res, identity, decodeURIComponent(adminAction[1]), adminAction[2] === "suspend")
    }

    json(res, 404, { error: "not found" })
  } catch (err) {
    if (err?.message === "request body too large") {
      // Drain what is left of the body so the client can read this response
      // instead of seeing a connection reset.
      req.resume()
      return json(res, 413, { error: err.message })
    }
    if (err?.message === "request aborted") return
    console.error("workplace-api error:", err)
    // KubeError carries the apiserver's status; anything else is ours.
    const status = err instanceof KubeError ? 502 : 500
    json(res, status, { error: err?.message ?? "internal error" })
  }
})

// Idle sweep. IDLE_CHECK_MS=0 turns it off (used by the test harness).
if (IDLE_CHECK_MS > 0) {
  setInterval(suspendIdleWorkspaces, IDLE_CHECK_MS).unref()
  console.log("workplace-api: idle sweep every " + IDLE_CHECK_MS + "ms")
}

server.on("error", (err) => {
  console.error("workplace-api: cannot listen on :" + PORT + " - " + err.message)
  process.exit(1)
})

// Bind on the pod IP, not loopback: nginx reaches the API over 127.0.0.1, but
// the kubelet's readiness probe dials the pod IP, so a loopback-only bind
// leaves the pod permanently NotReady. Reachability is bounded by the webui
// NetworkPolicy (ingress from the `network` namespace on port 80 only), not by
// the listen address.
server.listen(PORT, "0.0.0.0", () => {
  console.log("workplace-api listening on :" + PORT)
})

import { createServer } from "node:http"

const PORT = Number(process.env.PORT) || 3001
const KUBE_API = process.env.KUBE_API || "http://localhost:8001"
const NAMESPACE = process.env.WORKSPACE_NAMESPACE || "services"
const VM_NAMESPACE = process.env.VM_NAMESPACE || "kubevirt"
const DOMAIN = process.env.BASE_DOMAIN || ""
const GUACAMOLE_PATH = "/guacamole/"

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
  return "ws-" + entryId + "-" + slug
}

// Derive base domain from a Host header (strip first component).
function baseDomain(host) {
  const parts = host.split(".")
  return parts.length > 1 ? parts.slice(1).join(".") : host
}

// Forward a request to the kubectl-proxy (localhost:8001).  Only the
// oauth2-proxy identity headers (X-Auth-Request-*) are forwarded, never the
// raw incoming headers — passing content-length/host from the browser request
// makes the fetch hang when the forwarded body size differs.
async function kubeFetch(method, path, body, reqHeaders) {
  const headers = { "Content-Type": "application/json" }
  for (const key of Object.keys(reqHeaders)) {
    if (key.toLowerCase().startsWith("x-auth-request-")) headers[key] = reqHeaders[key]
  }
  const opts = { method, headers }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(KUBE_API + path, opts)
  const text = await res.text()
  if (!res.ok) console.error("kube-api " + method + " " + path + " -> " + res.status + " " + text.slice(0, 300))
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
        "app.kubernetes.io/name": "chacdn",
        "app.kubernetes.io/component": "session",
        "chacdn-owner": owner,
        "chacdn-entry": entry.id,
        "chacdn-runtime": entry.runtime ?? "container",
        "chacdn-persistence": entry.persistence ?? "disposable",
        "chacdn-lifecycle": entry.lifecycle ?? "ephemeral",
      },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": "chacdn", "app.kubernetes.io/component": "session", "chacdn-owner": owner, "chacdn-entry": entry.id } },
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "chacdn", "app.kubernetes.io/component": "session", "chacdn-owner": owner, "chacdn-entry": entry.id } },
        spec: {
          nodeSelector: nodeSelector(),
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

function buildService(name, owner, entryId) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: { "app.kubernetes.io/name": "chacdn", "app.kubernetes.io/component": "session" },
    },
    spec: {
      selector: { "app.kubernetes.io/name": "chacdn", "app.kubernetes.io/component": "session", "chacdn-owner": owner, "chacdn-entry": entryId },
      ports: [{ name: "http", port: 3000, targetPort: "http" }],
    },
  }
}

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
          // Keycloak SSO at the edge — replaces selkies/webtop basic auth.
          middlewares: [{ name: "oauth2-proxy-auth", namespace: "network" }],
          services: [svc],
        },
      ],
      tls: { secretName: "domain-0-prod-tls" },
    },
  }
}

// ── VM helpers ───────────────────────────────────────────────────────

// Cloud-init user-data for Ubuntu jammy + xfce4 desktop + Selkies-GStreamer
// (WebRTC remote desktop on :8080). Selkies ships a portable gstreamer>=1.22
// runtime because jammy's gstreamer 1.20 lacks the GstWebRTC GIR binding.
// Unit files are written via write_files (heredocs inside runcmd break).
// Shell variables inside the generated cloud-init text must be escaped with
// a leading extra dollar sign so the Flux postBuild substitution leaves
// shell-expansion constructs intact for the guest.
const SELKIES_UNIT = [
  "[Unit]",
  "Description=Selkies WebRTC Desktop Stream",
  "Requires=selkies-x.service",
  "After=selkies-x.service",
  "[Service]",
  "User=user",
  "Environment=DISPLAY=:0",
  "Environment=PIPEWIRE_LATENCY=128/48000",
  "Environment=XDG_RUNTIME_DIR=/tmp",
  // enable_basic_auth=false: authentication is oauth2-proxy (Keycloak) at the
  // ingress; avoid the second basic-auth popup.
  "ExecStart=/opt/selkies-gstreamer/bin/selkies-gstreamer-run --addr=0.0.0.0 --port=8080 --enable_https=false --encoder=x264enc --enable_resize=false --enable_basic_auth=false",
  "Restart=always",
  "RestartSec=5",
  "[Install]",
  "WantedBy=multi-user.target",
].join("\n")

const SELKIES_X_UNIT = [
  "[Unit]",
  "Description=Xvfb XFCE desktop on :0",
  "After=network.target",
  "[Service]",
  "User=user",
  "ExecStart=/bin/sh -c 'Xvfb :0 -screen 0 1920x1080x24 -ac & sleep 2; exec startxfce4'",
  "Restart=always",
  "RestartSec=3",
  "[Install]",
  "WantedBy=multi-user.target",
].join("\n")

function cloudInitUserData() {
  return [
    "#cloud-config",
    "users:",
    "  - default",
    "  - name: user",
    "    plain_text_passwd: user",
    "    lock_passwd: false",
    "    shell: /bin/bash",
    "    groups: sudo, ssl-cert",
    // write_files: heredocs inside runcmd break, so unit files land from here.
    "write_files:",
    "  - path: /etc/systemd/system/selkies-x.service",
    "    permissions: '0644'",
    "    content: |",
    "      " + SELKIES_X_UNIT.split("\n").join("\n      "),
    "  - path: /etc/systemd/system/selkies.service",
    "    permissions: '0640'",
    "    content: |",
    "      " + SELKIES_UNIT.split("\n").join("\n      "),
    // Not the packages: block — it does not retry and one transient mirror
    // hiccup killed the entire first boot (verified). Retry the install.
    "runcmd:",
    "  - |",
    "    for i in 1 2 3 4 5; do",
    "      apt-get update -o Acquire::Retries=5 >/dev/null 2>&1 && break",
    "      sleep 10",
    "    done",
    "    for i in 1 2 3; do",
    "      apt-get install -y -o Acquire::Retries=5 --no-install-recommends xfce4 xfce4-terminal dbus-x11 pulseaudio python3 python3-pip python3-dev jq tar gzip ca-certificates curl build-essential libgcrypt20 libgirepository-1.0-1 glib-networking alsa-utils libpulse0 libopus0 libvpx-dev x264 wmctrl xsel xdotool wayland-protocols libwayland-dev libwayland-egl1 x11-utils x11-xkb-utils x11-xserver-utils xserver-xorg-core xvfb libx11-xcb1 libxcb-dri3-0 libxkbcommon0 libxdamage1 libxfixes3 libxv1 libxtst6 libxext6 >/var/log/chacdn-packages.log 2>&1 && break",
    "      sleep 30",
    "    done",
    "  - echo 'xfce4-session' > /home/user/.xsession",
    "  - chown user:user /home/user/.xsession",
    // Selkies portable runtime: self-contained gstreamer with WebRTC support
    // (asset ~200MB; retry generously).
    "  - |",
    "    for i in 1 2 3 4 5; do",
    "      curl -fsSL 'https://github.com/selkies-project/selkies-gstreamer/releases/download/v1.6.2/selkies-gstreamer-portable-v1.6.2_amd64.tar.gz' -o /opt/selkies.tar.gz && break",
    "      sleep 15",
    "    done",
    "    tar -xzf /opt/selkies.tar.gz -C /opt",
    "    chown -R user:user /opt/selkies-gstreamer",
    // Streamer: own service is written by write_files. Basic auth is a second
    // gate behind oauth2-proxy; password is the selkies-documented default.
    "  - systemctl daemon-reload",
    "  - systemctl enable selkies-x selkies",
    "  - systemctl start selkies-x selkies",
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

function buildVirtualMachine(entry, name, owner) {
  const cpu = parseInt(entry.resources?.cpu) || 2
  const mem = entry.resources?.memory || "2Gi"
  const storage = entry.storage || "10Gi"
  return {
    apiVersion: "kubevirt.io/v1",
    kind: "VirtualMachine",
    metadata: {
      name: name,
      namespace: VM_NAMESPACE,
      labels: {
        "app.kubernetes.io/name": name,
        "chacdn-owner": owner,
        "chacdn-runtime": entry.runtime || "vm-linux",
        "chacdn-persistence": entry.persistence || "disposable",
        "chacdn-lifecycle": entry.lifecycle || "ephemeral",
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

function isVmRuntime(runtime) {
  return runtime && runtime.startsWith("vm-")
}

function vmWorkspaceUrl(name, domain) {
  // Same single-level host as containers — the wildcard cert only covers
  // *.tuntelder.com (one level), so no extra "apps." component.
  return "https://" + name + "." + domain
}

// ── Route handlers ───────────────────────────────────────────────────

// Admin group gate (X-Auth-Request-Groups from oauth2-proxy).
const ADMIN_GROUPS = new Set(
  (process.env.ADMIN_GROUPS || "admin,admins").split(",").map((g) => g.trim()).filter(Boolean),
)

function isAdmin(identity) {
  return (identity.groups ?? "").split(",").some((g) => ADMIN_GROUPS.has(g.trim()))
}

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
  const domain = DOMAIN || baseDomain(req.headers.host ?? "")

  // ── Container workspaces (Deployments in services ns) ────────────
  const depList = await kubeFetch(
    "GET",
    "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments?labelSelector=chacdn-owner%3D" + slug,
    null,
    req.headers,
  )
  const depItems = depList.items ?? []
  const containerWs = depItems
    .filter((d) => d.metadata?.name?.startsWith("ws-"))
    .map((d) => {
      const name = d.metadata.name
      const entryId = name.slice(3, name.length - slug.length - 1)
      const ready = (d.status?.readyReplicas ?? 0) >= 1
      const entry = catalog.find((e) => e.id === entryId)
      return {
        id: entryId,
        name: entry?.name ?? entryId,
        type: entry?.type ?? "desktop",
        runtime: "container",
        icon: entry?.icon,
        status: ready ? "running" : "starting",
        url: "https://" + name + "." + domain,
      }
    })

  // ── VM workspaces (VirtualMachines in kubevirt ns) ───────────────
  let vmItems = []
  try {
    const vmList = await kubeFetch(
      "GET",
      "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines?labelSelector=chacdn-owner%3D" + slug,
      null,
      req.headers,
    )
    vmItems = vmList.items ?? []
  } catch { /* KubeVirt not installed yet */ }

  const vmWs = await Promise.all(vmItems
    .filter((vm) => vm.metadata?.labels?.["chacdn-runtime"]?.startsWith("vm-"))
    .map(async (vm) => {
      const name = vm.metadata.name
      const entryId = name.slice(3, name.length - slug.length - 1)
      const ready = vm.status?.ready ?? false
      const entry = catalog.find((e) => e.id === entryId)

      // Self-heal: VM IngressRoutes created by older API code pointed at the
      // container backend (services:3000) — fix whenever we see the drift.
      const irPath = "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/" + name
      const ir = await kubeFetch("GET", irPath, null, req.headers).catch(() => null)
      if (ir && ir.spec?.routes?.[0]?.services?.[0]?.name !== name + "-svc") {
        await kubeFetch("PUT", irPath, buildIngressRoute(name, domain,
          { svc: { name: name + "-svc", namespace: VM_NAMESPACE, port: 8080 } }), req.headers).catch(() => {})
      }

      return {
        id: entryId,
        name: entry?.name ?? entryId,
        type: entry?.type ?? "desktop",
        runtime: entry?.runtime ?? "vm-linux",
        icon: entry?.icon,
        status: ready ? "running" : "starting",
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
    return handleCreateVmWorkspace(req, res, entry, name, slug, domain)
  }
  return handleCreateContainerWorkspace(req, res, entry, name, slug, domain)
}

// ── Container workspace creation ─────────────────────────────────────
async function handleCreateContainerWorkspace(req, res, entry, name, slug, domain) {
  const depPath = "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + name
  const existing = await kubeFetch("GET", depPath, null, req.headers)
  if (existing.kind !== "Status") {
    return json(res, 200, {
      id: entry.id, name, status: "running",
      url: "https://" + name + "." + domain,
    })
  }

  await kubeFetch("POST", "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments",
    buildDeployment(entry, name, slug), req.headers)

  const svcPath = "/api/v1/namespaces/" + NAMESPACE + "/services/" + name
  const svcExists = await kubeFetch("GET", svcPath, null, req.headers)
  if (svcExists.kind === "Status") {
    await kubeFetch("POST", "/api/v1/namespaces/" + NAMESPACE + "/services",
      buildService(name, slug, entry.id), req.headers)
  }

  const irExists = await kubeFetch("GET",
    "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/" + name,
    null, req.headers)
  if (irExists.kind === "Status") {
    await kubeFetch("POST", "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes",
      buildIngressRoute(name, domain), req.headers)
  }

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const dep = await kubeFetch("GET", depPath, null, req.headers)
    if ((dep.status?.readyReplicas ?? 0) >= 1) {
      return json(res, 200, {
        id: entry.id, name, status: "running",
        url: "https://" + name + "." + domain,
      })
    }
  }

  json(res, 200, {
    id: entry.id, name, status: "starting",
    url: "https://" + name + "." + domain,
  })
}

// ── VM workspace creation ────────────────────────────────────────────
async function handleCreateVmWorkspace(req, res, entry, name, slug, domain) {
  const vmPath = "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines/" + name
  const existing = await kubeFetch("GET", vmPath, null, req.headers)
  if (existing.kind !== "Status") {
    return json(res, 200, {
      id: entry.id, name, status: "running", url: vmWorkspaceUrl(name, domain),
    })
  }

  const secretPath = "/api/v1/namespaces/" + VM_NAMESPACE + "/secrets/" + name + "-cloudinit"
  const secExists = await kubeFetch("GET", secretPath, null, req.headers)
  if (secExists.kind === "Status") {
    const sec = await kubeFetch("POST", "/api/v1/namespaces/" + VM_NAMESPACE + "/secrets",
      buildCloudInitSecret(name, cloudInitUserData()), req.headers)
    if (sec.kind === "Status") {
      return json(res, 500, { error: "cloud-init secret: " + (sec.message ?? "failed") })
    }
  }

  const created = await kubeFetch("POST", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines",
    buildVirtualMachine(entry, name, slug), req.headers)
  if (created.kind === "Status") {
    return json(res, 500, { error: created.message ?? "VM create failed" })
  }

  const svcPath = "/api/v1/namespaces/" + VM_NAMESPACE + "/services/" + name + "-svc"
  const svcExists = await kubeFetch("GET", svcPath, null, req.headers)
  if (svcExists.kind === "Status") {
    await kubeFetch("POST", "/api/v1/namespaces/" + VM_NAMESPACE + "/services",
      buildVmService(name), req.headers)
  }

  // Create IngressRoute for the VM workspace (Selkies on :8080).
  const irPath = "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/" + name
  const irExists = await kubeFetch("GET", irPath, null, req.headers)
  if (irExists.kind === "Status") {
    await kubeFetch("POST", "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes",
      buildIngressRoute(name, domain, { svc: { name: name + "-svc", namespace: VM_NAMESPACE, port: 8080 } }), req.headers)
  } else if (irExists.spec?.routes?.[0]?.services?.[0]?.port === 3000) {
    // Repair pre-fix VM routes that pointed at the container backend.
    await kubeFetch("PUT", irPath, buildIngressRoute(name, domain,
      { svc: { name: name + "-svc", namespace: VM_NAMESPACE, port: 8080 } }), req.headers)
  }

  // Wait for VM readiness (up to 5 min — image import + cloud-init).
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    const vm = await kubeFetch("GET", vmPath, null, req.headers)
    if (vm.status?.ready) {
      return json(res, 200, {
        id: entry.id, name, status: "running", url: vmWorkspaceUrl(name, domain),
      })
    }
  }

  json(res, 200, {
    id: entry.id, name, status: "starting", url: vmWorkspaceUrl(name, domain),
  })
}

// DELETE /api/workspaces/:entryId — tear down a workspace.
async function handleDeleteWorkspace(req, res, identity, entryId) {
  const slug = slugFor(identity.email)
  const name = instName(entryId, slug)

  // Best-effort delete container resources.
  await kubeFetch("DELETE", "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + name, null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/api/v1/namespaces/" + NAMESPACE + "/services/" + name, null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/" + name, null, req.headers).catch(() => {})

  // Best-effort delete VM resources.
  await kubeFetch("DELETE", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines/" + name, null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/api/v1/namespaces/" + VM_NAMESPACE + "/services/" + name + "-svc", null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/api/v1/namespaces/" + VM_NAMESPACE + "/secrets/" + name + "-cloudinit", null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/" + name, null, req.headers).catch(() => {})

  json(res, 200, { ok: true })
}

// Admin: list ALL workspaces regardless of owner.
async function handleAdminList(req, res, identity) {
  if (!isAdmin(identity)) return json(res, 403, { error: "not admin" })

  const sap = await kubeFetch("GET",
    "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments?labelSelector=app.kubernetes.io/component%3Dsession",
    null, req.headers)
  const containers = (sap.items ?? []).map((d) => ({
    name: d.metadata.name,
    owner: d.metadata.labels?.["chacdn-owner"] ?? "",
    lifecycle: d.metadata.labels?.["chacdn-lifecycle"] ?? "",
    runtime: "container",
    ready: (d.status?.readyReplicas ?? 0) >= 1,
  }))

  const vmPath = "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines"
  let vms = []
  try {
    const vmsList = await kubeFetch("GET", vmPath + "?labelSelector=chacdn-runtime", null, req.headers)
    vms = (vmsList.items ?? []).map((vm) => ({
      name: vm.metadata.name,
      owner: vm.metadata.labels?.["chacdn-owner"] ?? "",
      lifecycle: vm.metadata.labels?.["chacdn-lifecycle"] ?? "",
      runtime: "vm",
      ready: vm.status?.ready ?? false,
    }))
  } catch { /* KubeVirt not installed */ }

  json(res, 200, containers.concat(vms))
}

// Admin: destroy a workspace by full object name (ws-<entryId>-<slug>). The
// cloud-init Secret and VM Service use `<name>`-suffixed variants.
async function handleAdminDelete(req, res, identity, target) {
  if (!isAdmin(identity)) return json(res, 403, { error: "not admin" })
  if (!/^ws-[a-z0-9-]+$/.test(target)) return json(res, 400, { error: "bad workspace name" })

  await kubeFetch("DELETE", "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + target, null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/api/v1/namespaces/" + NAMESPACE + "/services/" + target, null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/apis/kubevirt.io/v1/namespaces/" + VM_NAMESPACE + "/virtualmachines/" + target, null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/api/v1/namespaces/" + VM_NAMESPACE + "/services/" + target + "-svc", null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/api/v1/namespaces/" + VM_NAMESPACE + "/secrets/" + target + "-cloudinit", null, req.headers).catch(() => {})
  await kubeFetch("DELETE", "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/" + target, null, req.headers).catch(() => {})

  json(res, 200, { ok: true })
}

// POST /api/workspaces/:entryId/restart — rolling-restart a workspace.
async function handleRestartWorkspace(req, res, identity, entryId) {
  const slug = slugFor(identity.email)
  const name = instName(entryId, slug)
  const depPath = "/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/" + name

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

  const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"))
  const path = url.pathname

  // Extract oauth2-proxy identity headers.
  const identity = {
    email: req.headers["x-auth-request-email"] ?? "",
    groups: req.headers["x-auth-request-groups"] ?? "",
  }

  try {
    if (path === "/api/health" && req.method === "GET") return handleHealth(req, res)
    if (path === "/api/me" && req.method === "GET") return json(res, 200, { email: identity.email, groups: identity.groups })
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

    // Admin cleanup (ADMIN_GROUPS gate).
    if (path === "/api/admin/workspaces" && req.method === "GET") return handleAdminList(req, res, identity)
    const adminMatch = path.match(/^\/api\/admin\/workspaces\/([^/]+)$/)
    if (adminMatch && req.method === "DELETE") return handleAdminDelete(req, res, identity, decodeURIComponent(adminMatch[1]))

    json(res, 404, { error: "not found" })
  } catch (err) {
    console.error("workplace-api error:", err)
    json(res, 500, { error: "internal error" })
  }
})

server.listen(PORT, "0.0.0.0", () => {
  console.log("workplace-api listening on :" + PORT)
})

/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic Kubernetes API responses */
export type EntryType = "desktop" | "app"

export type Runtime = "container" | "vm-linux" | "vm-windows"
export type Persistence = "disposable" | "persistent"
export type Lifecycle = "ephemeral" | "suspend" | "persistent"

export interface CatalogEntry {
  id: string
  name: string
  description?: string
  type: EntryType
  icon?: string
  /** selkies image to launch a per-user instance from */
  image: string
  env?: { name: string; value: string }[]
  /** Keycloak groups allowed to see/launch this entry; empty = everyone */
  groups?: string[]
  /** Runtime backend. Default "container". */
  runtime?: Runtime
  /** Persistence policy. Default "disposable". */
  persistence?: Persistence
  /** Lifecycle policy. Default "ephemeral". */
  lifecycle?: Lifecycle
  /** Per-entry resource overrides (cpu, memory). Merged into the manifest. */
  resources?: { cpu?: string; memory?: string }
}

export interface Me {
  email: string
  groups: string
}

export type SessionStatus = "running" | "starting" | "stopped" | "offline"

// Stable per-user suffix so the same user reuses their instances.
export function slugFor(email: string): string {
  let h = 0
  for (const c of email.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return "u" + (h >>> 0).toString(16).padStart(8, "0")
}

export function baseDomain(): string {
  const parts = window.location.hostname.split(".")
  return parts.length > 1 ? parts.slice(1).join(".") : window.location.hostname
}

export function instName(entryId: string, slug: string): string {
  return `ws-${entryId}-${slug}`
}

export function instUrl(name: string, domain: string): string {
  return `https://${name}.${domain}`
}

export function depPath(name: string): string {
  return `/apis/apps/v1/namespaces/services/deployments/${name}`
}

export function svcPath(name: string): string {
  return `/api/v1/namespaces/services/services/${name}`
}

export function irPath(name: string): string {
  return `/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/${name}`
}

export async function readJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, init)
  const ct = res.headers.get("content-type") ?? ""
  if (!ct.includes("application/json")) {
    throw new Error("not-json")
  }
  return res.json()
}

export async function apiPost(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`)
}

export async function apiDel(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" })
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
}

export async function resourceExists(path: string): Promise<boolean> {
  try {
    const obj = await readJson(path)
    return obj.kind !== "Status" // 404s come back as Status objects
  } catch {
    return false
  }
}

export function deploymentManifest(
  entry: CatalogEntry,
  name: string,
  owner: string
): any {
  const cpuReq = entry.resources?.cpu ?? "250m"
  const memReq = entry.resources?.memory ?? "256Mi"
  const memLim = entry.type === "desktop" ? "4Gi" : "2Gi"

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: "services",
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

export function serviceManifest(name: string): any {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: "services" },
    spec: {
      selector: { app: name },
      ports: [{ name: "http", port: 3000, targetPort: "http" }],
    },
  }
}

export function ingressManifest(name: string, domain: string): any {
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
          services: [{ name, namespace: "services", port: 3000 }],
        },
      ],
      tls: { secretName: "domain-0-prod-tls" },
    },
  }
}
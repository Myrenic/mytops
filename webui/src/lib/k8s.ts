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

export function depPath(name: string): string {
  return `/apis/apps/v1/namespaces/services/deployments/${name}`
}

export async function readJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, init)
  const ct = res.headers.get("content-type") ?? ""
  if (!ct.includes("application/json")) {
    throw new Error("not-json")
  }
  return res.json()
}

/**
 * Workplace API client — the SPA's only interface to workspace provisioning.
 * All k8s operations are validated server-side; the browser never touches
 * the Kubernetes API directly.
 */

const API = "/api"

// ── Types ────────────────────────────────────────────────────────────
export type EntryType = "desktop" | "app"
export type Runtime = "container" | "vm-linux" | "vm-windows"
export type Persistence = "disposable" | "persistent"
export type Lifecycle = "ephemeral" | "suspend" | "persistent"
export type SessionStatus = "running" | "starting" | "stopped" | "offline"

export interface Workspace {
  id: string
  name: string
  type: string
  runtime?: Runtime
  icon?: string
  persistence?: Persistence
  lifecycle?: Lifecycle
  status: "running" | "starting"
  url: string
}

export interface CatalogEntry {
  id: string
  name: string
  description?: string
  type: EntryType
  icon?: string
  /** selkies image to launch a per-user instance from (omitted for VMs). */
  image?: string
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
  /** VM-only: PVC size for the root disk. */
  storage?: string
}

export interface Me {
  email: string
  groups: string
}

// ── Helpers ──────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// Stable per-user suffix so the same user reuses their instances.
export function slugFor(email: string): string {
  let h = 0
  for (const c of email.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return "u" + (h >>> 0).toString(16).padStart(8, "0")
}

// Derive base domain from the current hostname (strip first component).
export function baseDomain(): string {
  const parts = window.location.hostname.split(".")
  return parts.length > 1 ? parts.slice(1).join(".") : window.location.hostname
}

// ── API calls ────────────────────────────────────────────────────────

/** Fetch the identity of the current user (SSI endpoint). */
export function fetchMe(): Promise<Me> {
  return apiFetch("/me")
}

/** Fetch the server-side catalog. */
export function fetchCatalog(): Promise<{ apps: CatalogEntry[] }> {
  return apiFetch("/catalog")
}

/** List workspaces for the current user (includes live status). */
export function listWorkspaces(): Promise<Workspace[]> {
  return apiFetch("/workspaces")
}

/** Create a workspace from a catalog entry (server-side validated). */
export function createWorkspace(catalogId: string): Promise<Workspace> {
  return apiFetch("/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalogId }),
  })
}

/** Restart a workspace (rolling-restart the Deployment). */
export function restartWorkspace(catalogId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/workspaces/${encodeURIComponent(catalogId)}`, {
    method: "POST",
  })
}

/** End (delete) a workspace and its service/ingress. */
export function endWorkspace(catalogId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/workspaces/${encodeURIComponent(catalogId)}`, {
    method: "DELETE",
  })
}

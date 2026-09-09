/**
 * Workplace API client — the SPA's only interface to workspace provisioning.
 * All k8s operations are validated server-side; the browser never touches
 * the Kubernetes API directly.
 */

const API = "/api"

// ── Types ────────────────────────────────────────────────────────────
export interface Workspace {
  id: string
  name: string
  type: string
  icon?: string
  status: "running" | "starting"
  url: string
}

export interface CatalogEntry {
  id: string
  name: string
  description?: string
  type: "desktop" | "app"
  icon?: string
  image: string
  env?: { name: string; value: string }[]
  groups?: string[]
  runtime?: "container" | "vm-linux" | "vm-windows"
  persistence?: "disposable" | "persistent"
  lifecycle?: "ephemeral" | "suspend" | "persistent"
  resources?: { cpu?: string; memory?: string }
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

// ── API calls ────────────────────────────────────────────────────────

/** Fetch the identity of the current user (SSI endpoint). */
export function fetchMe(): Promise<Me> {
  return apiFetch("/me")
}

/** Fetch the server-side catalog. */
export function fetchCatalog(): Promise<{ apps: CatalogEntry[] }> {
  return apiFetch("/catalog")
}

/** List workspaces for the current user. */
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

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
export type SessionStatus = "running" | "starting" | "stopped" | "offline" | "suspended"

export interface Workspace {
  id: string
  name: string
  type: string
  runtime?: Runtime
  icon?: string
  persistence?: Persistence
  lifecycle?: Lifecycle
  status: SessionStatus
  streamReady?: boolean
  /** Epoch ms of the last heartbeat/stream open; absent for old objects. */
  lastActiveAt?: number
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
  /** Size of the per-user home volume this entry mounts (persistent entries). */
  homeStorage?: string
  /** Minutes a workspace may sit unused before it is stopped (0/absent = never). */
  idleSuspendMinutes?: number
}

export interface Me {
  email: string
  groups: string
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Failure of a workplace API call: `status` is the HTTP status (0 if the
 *  request never got an answer). */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/** JSON.parse that reports a parse failure as `undefined` (JSON has no
 *  `undefined` value, so this cannot collide with a valid body). */
function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, init)
  } catch (err) {
    // A dead session is not a network error we can see: oauth2-proxy answers
    // with a redirect to Keycloak, and the follow-up request to another origin
    // fails the CORS check, which fetch reports as a TypeError.
    throw new ApiError(err instanceof Error ? err.message : String(err), 0)
  }

  const body = parseJsonOrUndefined(await res.text())
  if (body === undefined) {
    // Not JSON: an oauth2-proxy/Keycloak HTML page (session gone), or
    // something other than the workplace API answered.
    throw new ApiError("not-json", res.status)
  }

  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error
    throw new ApiError(message ?? `HTTP ${res.status}`, res.status)
  }
  return body as T
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

/** Tell the API a workspace is on screen, so it is not suspended as idle. */
export function touchWorkspace(catalogId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/workspaces/${encodeURIComponent(catalogId)}/touch`, {
    method: "POST",
  })
}

/** Restart a workspace (rolling-restart the Deployment / reboot the VM). */
export function restartWorkspace(
  catalogId: string
): Promise<{ ok: boolean; status: SessionStatus }> {
  return apiFetch(`/workspaces/${encodeURIComponent(catalogId)}/restart`, {
    method: "POST",
  })
}

/** End (delete) a workspace and its service/ingress. */
export function endWorkspace(catalogId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/workspaces/${encodeURIComponent(catalogId)}`, {
    method: "DELETE",
  })
}

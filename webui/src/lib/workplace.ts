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
  /** Whether the server considers this caller an admin (it enforces it too). */
  isAdmin: boolean
}

/** A workspace as an admin sees it: anyone's, with who owns it. */
export interface AdminWorkspace {
  name: string
  entryId: string
  entryName: string
  runtime: "container" | "vm"
  owner: string
  ownerEmail: string | null
  lifecycle: string
  persistence: string
  status: SessionStatus
  lastActiveAt?: number
  home: { name: string; phase: string; size: string } | null
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

export interface FileEntry {
  name: string
  kind: "file" | "dir" | "link"
  size: number
  mtime: number
  mode?: number
}

export interface FileListing {
  path: string
  entries: FileEntry[]
}

export interface FileUsage {
  totalBytes: number
  freeBytes: number
}

/** Where a file API call should go: your own home, or (admins) someone's. */
export type FileTarget = { owner?: string }

function fileQuery(target: FileTarget, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra)
  if (target.owner) params.set("owner", target.owner)
  return params.toString()
}

export function listFiles(path: string, target: FileTarget = {}): Promise<FileListing> {
  return apiFetch(`/files/list?${fileQuery(target, { path })}`)
}

export function fileUsage(target: FileTarget = {}): Promise<FileUsage> {
  return apiFetch(`/files/usage?${fileQuery(target)}`)
}

/** URL for a download link; `inline` previews instead of downloading. */
export function fileContentUrl(
  path: string,
  target: FileTarget = {},
  inline = false
): string {
  const query = fileQuery(target, { path, ...(inline ? { inline: "1" } : {}) })
  return `${API}/files/content?${query}`
}

export async function writeFile(
  path: string,
  body: Blob | string,
  target: FileTarget = {}
): Promise<{ ok: boolean; size: number }> {
  const res = await fetch(`${API}/files/content?${fileQuery(target, { path })}`, {
    method: "PUT",
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    let message = `HTTP ${res.status}`
    try {
      message = JSON.parse(text).error ?? message
    } catch {
      /* not json */
    }
    throw new ApiError(message, res.status)
  }
  return res.json()
}

export function makeDirectory(
  path: string,
  target: FileTarget = {}
): Promise<{ ok: boolean }> {
  return apiFetch(`/files/dir?${fileQuery(target, { path })}`, { method: "POST" })
}

export function moveFile(
  from: string,
  to: string,
  target: FileTarget = {}
): Promise<{ ok: boolean }> {
  return apiFetch(`/files/move?${fileQuery(target, { from, to })}`, {
    method: "POST",
  })
}

export function deleteFile(
  path: string,
  target: FileTarget = {}
): Promise<{ ok: boolean }> {
  return apiFetch(`/files/entry?${fileQuery(target, { path })}`, {
    method: "DELETE",
  })
}

/** Admin: every workspace, whoever owns it. */
export function adminListWorkspaces(): Promise<AdminWorkspace[]> {
  return apiFetch("/admin/workspaces")
}

/** Admin: stop or start someone else's workspace (keeps their home volume). */
export function adminSuspendWorkspace(
  name: string,
  suspend: boolean
): Promise<{ ok: boolean; status: SessionStatus }> {
  return apiFetch(
    `/admin/workspaces/${encodeURIComponent(name)}/${suspend ? "suspend" : "resume"}`,
    { method: "POST" }
  )
}

/** Admin: destroy someone else's workspace (their home volume is kept). */
export function adminDestroyWorkspace(name: string): Promise<{ ok: boolean }> {
  return apiFetch(`/admin/workspaces/${encodeURIComponent(name)}`, {
    method: "DELETE",
  })
}

/** End (delete) a workspace and its service/ingress. */
export function endWorkspace(catalogId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/workspaces/${encodeURIComponent(catalogId)}`, {
    method: "DELETE",
  })
}

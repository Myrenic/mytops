import { useEffect, useMemo, useState } from "react"
import { LogOut, Monitor, Play, RotateCw, Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

type EntryType = "desktop" | "app"

interface CatalogEntry {
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
}

interface Me {
  email: string
  groups: string
}

const FILTERS: { id: EntryType | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "desktop", label: "Desktops" },
  { id: "app", label: "Apps" },
]

const FALLBACK_ICON: Record<EntryType, string> = {
  desktop: "🖥️",
  app: "🧩",
}

// Stable per-user suffix so the same user reuses their instances.
function slugFor(email: string): string {
  let h = 0
  for (const c of email.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return "u" + (h >>> 0).toString(16).padStart(8, "0")
}

function baseDomain(): string {
  const parts = window.location.hostname.split(".")
  return parts.length > 1 ? parts.slice(1).join(".") : window.location.hostname
}

async function readJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, init)
  const ct = res.headers.get("content-type") ?? ""
  if (!ct.includes("application/json")) {
    throw new Error("not-json")
  }
  return res.json()
}

function deploymentManifest(entry: CatalogEntry, name: string, owner: string): any {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: "services",
      labels: { app: name, "chacdn-owner": owner },
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
                requests: { cpu: "250m", memory: "256Mi" },
                limits: { memory: entry.type === "desktop" ? "4Gi" : "2Gi" },
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

function serviceManifest(name: string): any {
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

function ingressManifest(name: string, domain: string): any {
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

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<EntryType | "all">("all")

  // Open workspaces (per-user instances) + which one is shown in the frame.
  const [workspaces, setWorkspaces] = useState<CatalogEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [restartingId, setRestartingId] = useState<string | null>(null)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [frameNonce, setFrameNonce] = useState(0)

  const slug = useMemo(() => (me ? slugFor(me.email) : ""), [me])
  const domain = useMemo(() => baseDomain(), [])
  const myGroups = useMemo(
    () =>
      new Set(
        (me?.groups ?? "")
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean)
      ),
    [me]
  )
  const canAccess = (e: CatalogEntry) =>
    !e.groups?.length || e.groups.some((g) => myGroups.has(g))
  const instName = (e: CatalogEntry) => `ws-${e.id}-${slug}`
  const instUrl = (e: CatalogEntry) => `https://${instName(e)}.${domain}`
  const depPath = (e: CatalogEntry) =>
    `/apis/apps/v1/namespaces/services/deployments/${instName(e)}`

  // Identity + catalog. oauth2-proxy gates the whole host, so /me is JSON
  // unless the session expired (then it's the login page -> not-json).
  useEffect(() => {
    ;(async () => {
      try {
        const [m, cat] = await Promise.all([
          readJson("/me"),
          readJson("catalog.json", { cache: "no-store" }),
        ])
        setMe(m)
        setEntries(Array.isArray(cat.apps) ? cat.apps : [])
        setError(null)
      } catch (err) {
        setError(err instanceof Error && err.message === "not-json"
          ? "You are not signed in."
          : err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // If the session dies mid-use, tear the user's instances down and let
  // oauth2-proxy bounce us back to the login page.
  useEffect(() => {
    if (!me) return
    const t = setInterval(async () => {
      try {
        await readJson("/me")
      } catch {
        await teardownAll()
        window.location.reload()
      }
    }, 60000)
    return () => clearInterval(t)
  }, [me])

  // Restore open sessions from the cluster: the per-user instances are the
  // source of truth, so a refresh keeps the top-bar tabs (and the last active
  // one). Tabs that were closed (pods deleted) stay gone.
  useEffect(() => {
    if (!me || !entries.length) return
    ;(async () => {
      try {
        const list = await readJson(
          `/apis/apps/v1/namespaces/services/deployments?labelSelector=chacdn-owner%3D${slug}`
        )
        const items: { metadata: { name: string } }[] = list.items ?? []
        const openIds = items
          .map((d) => d.metadata.name)
          .filter((n) => n.startsWith("ws-") && n.endsWith(`-${slug}`))
          .map((n) => n.slice(3, n.length - slug.length - 1))
        const restored = entries.filter(
          (e) => canAccess(e) && openIds.includes(e.id)
        )
        setWorkspaces(restored)
        const last = localStorage.getItem("chacdn-active")
        setActiveId(
          last && restored.some((w) => w.id === last)
            ? last
            : (restored[0]?.id ?? null)
        )
      } catch {
        // not fatal: start with an empty top bar
      }
    })()
  }, [me, entries, slug])

  // Remember which tab was active so a refresh lands back on it.
  useEffect(() => {
    if (activeId) localStorage.setItem("chacdn-active", activeId)
  }, [activeId])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (!canAccess(e)) return false
      return (
        (filter === "all" || e.type === filter) &&
        (!q ||
          (e.name + " " + (e.description ?? "")).toLowerCase().includes(q))
      )
    })
  }, [entries, query, filter, me])

  const active = workspaces.find((w) => w.id === activeId) ?? null

  const apiPost = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`)
  }

  const apiDel = async (path: string) => {
    const res = await fetch(path, { method: "DELETE" })
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
  }

  const resourceExists = async (path: string) => {
    try {
      const obj = await readJson(path)
      return obj.kind !== "Status" // 404s come back as Status objects
    } catch {
      return false
    }
  }

  const ensureInstance = async (e: CatalogEntry) => {
    const name = instName(e)
    // Check and create each resource independently: an orphaned Deployment
    // from an earlier partial connect must not skip Service/IngressRoute
    // creation (otherwise the host falls through to the Traefik catch-all).
    if (!(await resourceExists(depPath(e)))) {
      await apiPost(
        "/apis/apps/v1/namespaces/services/deployments",
        deploymentManifest(e, name, slug)
      )
    }
    const svcPath = `/api/v1/namespaces/services/services/${name}`
    if (!(await resourceExists(svcPath))) {
      await apiPost("/api/v1/namespaces/services/services", serviceManifest(name))
    }
    const irPath = `/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/${name}`
    if (!(await resourceExists(irPath))) {
      await apiPost(
        "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes",
        ingressManifest(name, domain)
      )
    }
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      const dep = await readJson(depPath(e))
      if ((dep.status?.readyReplicas ?? 0) >= 1) return
    }
    throw new Error("instance did not become ready")
  }

  const connect = async (e: CatalogEntry) => {
    setStartingId(e.id)
    setError(null)
    try {
      await ensureInstance(e)
      setWorkspaces((prev) =>
        prev.some((w) => w.id === e.id) ? prev : [...prev, e]
      )
      setActiveId(e.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStartingId(null)
    }
  }

  const deleteInstance = async (name: string) => {
    await apiDel(`/apis/apps/v1/namespaces/services/deployments/${name}`)
    await apiDel(`/api/v1/namespaces/services/services/${name}`)
    await apiDel(
      `/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes/${name}`
    )
  }

  // Closing a tab really shuts the workspace down (pod + service + route).
  const closeWorkspace = async (id: string) => {
    const e = workspaces.find((w) => w.id === id)
    if (e) {
      try {
        await deleteInstance(instName(e))
      } catch {
        // best effort; still drop the tab
      }
    }
    const rest = workspaces.filter((w) => w.id !== id)
    setWorkspaces(rest)
    if (activeId === id) {
      setActiveId(rest.length ? rest[rest.length - 1].id : null)
    }
  }

  const restart = async (e: CatalogEntry) => {
    setRestartingId(e.id)
    setRestartError(null)
    try {
      const res = await fetch(depPath(e), {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify({
          spec: {
            template: {
              metadata: {
                annotations: { "chacdn/restartedAt": new Date().toISOString() },
              },
            },
          },
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000))
        const dep = await readJson(depPath(e))
        if ((dep.status?.readyReplicas ?? 0) >= 1) break
      }
      setFrameNonce((n) => n + 1)
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestartingId(null)
    }
  }

  const teardownAll = async () => {
    if (!slug) return
    try {
      const list = await readJson(
        `/apis/apps/v1/namespaces/services/deployments?labelSelector=chacdn-owner%3D${slug}`
      )
      for (const d of list.items ?? []) {
        await deleteInstance(d.metadata.name as string)
      }
    } catch {
      // best effort
    }
    localStorage.removeItem("chacdn-active")
    setWorkspaces([])
    setActiveId(null)
  }

  const logout = async () => {
    await teardownAll()
    const rd = encodeURIComponent(window.location.origin)
    window.location.href = `https://auth.${domain}/oauth2/sign_out?rd=${rd}`
  }

  if (loading) {
    return (
      <div className="grid min-h-svh place-items-center bg-background text-sm text-muted-foreground">
        Signing in…
      </div>
    )
  }

  if (error) {
    return (
      <div className="grid min-h-svh place-items-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="max-w-md text-sm text-muted-foreground">{error}</p>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      {/* Top bar: brand + one tab per open workspace + user */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
        <button
          type="button"
          onClick={() => setActiveId(null)}
          title="Browse apps & desktops"
          className="flex h-8 shrink-0 items-center gap-2 rounded-md px-2 hover:bg-muted"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded bg-primary text-primary-foreground">
            <Monitor className="size-4" />
          </span>
          <span className="hidden text-sm font-semibold sm:inline">
            Desktops &amp; Apps
          </span>
        </button>

        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {workspaces.length === 0 && (
            <span className="px-1 text-sm text-muted-foreground">
              Pick an app or desktop to connect
            </span>
          )}
          {workspaces.map((w) => {
            const isActive = w.id === activeId
            return (
              <div
                key={w.id}
                role="button"
                tabIndex={0}
                onClick={() => setActiveId(w.id)}
                onKeyDown={(e) => e.key === "Enter" && setActiveId(w.id)}
                className={`flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <span className="text-sm leading-none">
                  {w.icon || FALLBACK_ICON[w.type]}
                </span>
                <span className="max-w-40 truncate">{w.name}</span>
                <span
                  role="button"
                  title={`Close ${w.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeWorkspace(w.id)
                  }}
                  className={`ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm ${
                    isActive
                      ? "hover:bg-primary-foreground/20"
                      : "hover:bg-muted"
                  }`}
                >
                  <X className="size-3" />
                </span>
              </div>
            )
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {active && (
            <>
              {restartError && (
                <span
                  className="max-w-56 truncate text-xs text-destructive"
                  title={restartError}
                >
                  Restart failed
                </span>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => restart(active)}
                disabled={restartingId !== null}
                title="Recreate this workspace with a fresh pod"
              >
                <RotateCw
                  className={`size-4 ${
                    restartingId === active.id ? "animate-spin" : ""
                  }`}
                />
                <span className="hidden sm:inline">
                  {restartingId === active.id ? "Restarting…" : "Restart"}
                </span>
              </Button>
            </>
          )}
          <span className="hidden max-w-48 truncate text-xs text-muted-foreground md:inline">
            {me?.email}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={logout}
            title="Sign out and shut down your workspaces"
          >
            <LogOut className="size-4" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>

      {active ? (
        // Embedded Selkies workspace; only the active one is mounted so the
        // video stream stops when you switch (the pod keeps running).
        <div className="relative min-h-0 flex-1 bg-black">
          <iframe
            key={`${active.id}-${frameNonce}`}
            src={instUrl(active)}
            title={active.name}
            className="block h-full w-full border-0"
            allow="autoplay; clipboard-read; clipboard-write; display-capture; fullscreen; microphone; pointer-lock"
          />
          {(restartingId === active.id || restartError) && (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background/95 text-sm text-muted-foreground">
              {restartingId === active.id
                ? "Restarting workspace — this can take a minute…"
                : `Restart failed: ${restartError}`}
            </div>
          )}
        </div>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-6 py-6">
            <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-center">
              <div className="relative w-full sm:max-w-sm">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search apps and desktops…"
                  className="pl-9"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {FILTERS.map((f) => (
                  <Button
                    key={f.id}
                    variant={filter === f.id ? "default" : "secondary"}
                    size="sm"
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {error ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {error}
              </p>
            ) : visible.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Nothing assigned to you yet.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((e) => (
                  <Card key={e.id} className="flex h-full flex-col">
                    <CardHeader className="flex items-center gap-3 space-y-0">
                      <div className="grid size-11 shrink-0 place-items-center rounded-md bg-muted text-2xl">
                        {e.icon || FALLBACK_ICON[e.type]}
                      </div>
                      <CardTitle className="flex-1">{e.name}</CardTitle>
                      <Badge
                        variant={e.type === "desktop" ? "secondary" : "outline"}
                      >
                        {e.type}
                      </Badge>
                    </CardHeader>
                    <CardContent className="flex-1 text-sm text-muted-foreground">
                      {e.description}
                    </CardContent>
                    <CardFooter>
                      <Button
                        className="w-full"
                        onClick={() => connect(e)}
                        disabled={startingId === e.id}
                      >
                        {startingId === e.id
                          ? "Starting…"
                          : workspaces.some((w) => w.id === e.id)
                            ? "Switch to"
                            : "Connect"}
                        <Play className="ml-2 size-4" />
                      </Button>
                    </CardFooter>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </main>
      )}
    </div>
  )
}

export default App
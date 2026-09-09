import { useEffect, useMemo, useRef, useState } from "react"
import {
  ExternalLink,
  LogOut,
  Maximize,
  Monitor,
  Moon,
  RotateCw,
  Sun,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTheme } from "@/components/theme-provider"
import {
  apiDel,
  apiPost,
  baseDomain,
  depPath,
  deploymentManifest,
  ingressManifest,
  instName,
  instUrl,
  irPath,
  readJson,
  resourceExists,
  serviceManifest,
  slugFor,
  svcPath,
  type CatalogEntry,
  type Me,
  type SessionStatus,
} from "@/lib/k8s"
import { Dashboard } from "@/views/Dashboard"
import { SessionView, type OverlayState } from "@/views/SessionView"

const FALLBACK_ICON: Record<string, string> = { desktop: "🖥️", app: "🧩" }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  // Open workspaces (per-user instances) + which one is shown in the frame.
  const [workspaces, setWorkspaces] = useState<CatalogEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [restartingId, setRestartingId] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<OverlayState | null>(null)
  const [statusById, setStatusById] = useState<Record<string, SessionStatus>>(
    {}
  )
  const [frameNonce, setFrameNonce] = useState(0)
  const frameRef = useRef<HTMLDivElement>(null)
  const { theme, setTheme } = useTheme()

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
  const openIds = workspaces.map((w) => w.id)
  const active = workspaces.find((w) => w.id === activeId) ?? null

  const deleteInstance = async (name: string) => {
    await apiDel(depPath(name))
    await apiDel(svcPath(name))
    await apiDel(irPath(name))
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
    setStatusById({})
    setActiveId(null)
    setOverlay(null)
  }

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
        setError(
          err instanceof Error && err.message === "not-json"
            ? "You are not signed in."
            : err instanceof Error
              ? err.message
              : String(err)
        )
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
        setStatusById(
          Object.fromEntries(restored.map((e) => [e.id, "running"]))
        )
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

  // Poll the live status of open workspaces so tiles/tabs reflect reality
  // (e.g. a pod that died or finished restarting) without a page reload.
  useEffect(() => {
    if (!slug || workspaces.length === 0) return
    const poll = async () => {
      for (const w of workspaces) {
        try {
          const dep = await readJson(depPath(instName(w.id, slug)))
          if (dep.kind === "Status") {
            // 404: terminated externally -> drop the tab like a manual close
            setWorkspaces((prev) => prev.filter((x) => x.id !== w.id))
            setStatusById((prev) => {
              const c = { ...prev }
              delete c[w.id]
              return c
            })
            setActiveId((prev) =>
              prev === w.id ? (workspaces.filter((x) => x.id !== w.id).at(-1)?.id ?? null) : prev
            )
            continue
          }
          const ready = (dep.status?.readyReplicas ?? 0) >= 1
          setStatusById((prev) => ({
            ...prev,
            [w.id]: ready ? "running" : "starting",
          }))
        } catch {
          // transient API error; leave status as-is
        }
      }
    }
    poll()
    const t = setInterval(poll, 15000)
    return () => clearInterval(t)
  }, [slug, workspaces])

  const ensureInstance = async (
    e: CatalogEntry,
    onPhase: (title: string, detail: string) => void
  ) => {
    const name = instName(e.id, slug)
    // Check and create each resource independently: an orphaned Deployment
    // from an earlier partial connect must not skip Service/IngressRoute
    // creation (otherwise the host falls through to the Traefik catch-all).
    if (!(await resourceExists(depPath(name)))) {
      onPhase("Provisioning workspace…", "Creating the workspace container.")
      await apiPost(
        "/apis/apps/v1/namespaces/services/deployments",
        deploymentManifest(e, name, slug)
      )
    }
    const svc = svcPath(name)
    if (!(await resourceExists(svc))) {
      await apiPost("/api/v1/namespaces/services/services", serviceManifest(name))
    }
    const ir = irPath(name)
    if (!(await resourceExists(ir))) {
      await apiPost(
        "/apis/traefik.io/v1alpha1/namespaces/network/ingressroutes",
        ingressManifest(name, domain)
      )
    }
    onPhase("Starting workspace…", "Waiting for the container to become ready.")
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      await sleep(3000)
      const dep = await readJson(depPath(name))
      if ((dep.status?.readyReplicas ?? 0) >= 1) return
    }
    throw new Error("instance did not become ready")
  }

  const select = (id: string | null) => {
    setOverlay(null)
    setActiveId(id)
  }

  const connect = async (e: CatalogEntry) => {
    setStartingId(e.id)
    setError(null)
    try {
      await ensureInstance(e, (title, detail) =>
        setOverlay({ title, detail })
      )
      setWorkspaces((prev) =>
        prev.some((w) => w.id === e.id) ? prev : [...prev, e]
      )
      setStatusById((prev) => ({ ...prev, [e.id]: "running" }))
      setOverlay(null)
      setActiveId(e.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setOverlay(null)
    } finally {
      setStartingId(null)
    }
  }

  // Ending a workspace really shuts it down (pod + service + route).
  const endWorkspace = async (id: string) => {
    const e = workspaces.find((w) => w.id === id)
    if (e) {
      try {
        await deleteInstance(instName(e.id, slug))
      } catch {
        // best effort; still drop the tab
      }
    }
    const rest = workspaces.filter((w) => w.id !== id)
    setWorkspaces(rest)
    setStatusById((prev) => {
      const c = { ...prev }
      delete c[id]
      return c
    })
    if (activeId === id) setActiveId(rest.length ? rest[rest.length - 1].id : null)
  }

  const restart = async (e: CatalogEntry) => {
    setRestartingId(e.id)
    setOverlay({
      title: `Restarting ${e.name}…`,
      detail: "This can take a minute.",
    })
    try {
      const res = await fetch(depPath(instName(e.id, slug)), {
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
      setOverlay({
        title: `Restarting ${e.name}…`,
        detail: "Waiting for a fresh container…",
      })
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        await sleep(3000)
        const dep = await readJson(depPath(instName(e.id, slug)))
        if ((dep.status?.readyReplicas ?? 0) >= 1) break
      }
      setFrameNonce((n) => n + 1)
      setOverlay(null)
      setStatusById((prev) => ({ ...prev, [e.id]: "running" }))
    } catch (err) {
      setOverlay({
        title: "Restart failed",
        detail: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRestartingId(null)
    }
  }

  const logout = async () => {
    await teardownAll()
    // Chain: oauth2-proxy clears its session cookie, then Keycloak's
    // end-session endpoint clears the IdP SSO cookie (otherwise the browser
    // auto-logs-in again via the surviving Keycloak session).
    const rd = encodeURIComponent(`https://apps.${domain}/`)
    const kcLogout = encodeURIComponent(
      `https://keycloak.${domain}/realms/chacdn/protocol/openid-connect/logout?client_id=webui&post_logout_redirect_uri=${rd}`
    )
    window.location.href = `https://auth.${domain}/oauth2/sign_out?rd=${kcLogout}`
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      frameRef.current?.requestFullscreen?.()
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-svh place-items-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Monitor className="size-6" />
          </span>
          <p className="text-sm text-muted-foreground">Loading your workspaces…</p>
        </div>
      </div>
    )
  }

  if (error && !me) {
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
      {/* Top bar: brand + one tab per open workspace + actions */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b bg-card/80 px-2 backdrop-blur">
        <button
          type="button"
          onClick={() => select(null)}
          title="Back to workspace catalog"
          className="flex h-8 shrink-0 items-center gap-2 rounded-md px-2 hover:bg-muted"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <Monitor className="size-4" />
          </span>
          <span className="hidden text-sm font-semibold sm:inline">
            Chacdn
          </span>
        </button>

        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {workspaces.length === 0 && (
            <span className="px-1 text-sm text-muted-foreground">
              Launch a workspace from the catalog
            </span>
          )}
          {workspaces.map((w) => {
            const isActive = w.id === activeId
            const status = statusById[w.id] ?? "starting"
            const dot =
              status === "running" ? "dot-running" : status === "starting" ? "dot-starting" : "dot-offline"
            return (
              <div
                key={w.id}
                role="button"
                tabIndex={0}
                onClick={() => select(w.id)}
                onKeyDown={(e) => e.key === "Enter" && select(w.id)}
                className={`flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {status === "starting" ? (
                    <span className={`inline-block size-2 shrink-0 rounded-full ${dot}`} />
                  ) : (
                    <span className="text-sm leading-none">
                      {w.icon || FALLBACK_ICON[w.type]}
                    </span>
                  )}
                </span>
                <span className="max-w-40 truncate">{w.name}</span>
                <span
                  role="button"
                  title={`End ${w.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    endWorkspace(w.id)
                  }}
                  className={`ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm ${
                    isActive ? "hover:bg-primary-foreground/20" : "hover:bg-muted"
                  }`}
                >
                  <X className="size-3" />
                </span>
              </div>
            )
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {active && (
            <>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => restart(active)}
                disabled={restartingId !== null}
                title="Restart this workspace with a fresh pod"
              >
                <RotateCw
                  className={restartingId === active.id ? "animate-spin" : ""}
                />
              </Button>
              <a
                href={instUrl(instName(active.id, slug), domain)}
                target="_blank"
                rel="noreferrer"
                title="Open in a new tab"
                className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ExternalLink className="size-4" />
              </a>
              <Button
                size="icon"
                variant="ghost"
                onClick={toggleFullscreen}
                title="Fullscreen"
              >
                <Maximize className="size-4" />
              </Button>
            </>
          )}

          <Button
            size="icon"
            variant="ghost"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle theme"
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>

          <span className="hidden max-w-48 truncate px-1 text-xs text-muted-foreground md:inline">
            {me?.email}
          </span>
          <Button
            size="icon"
            variant="ghost"
            onClick={logout}
            title="Sign out and shut down your workspaces"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      {active ? (
        <SessionView
          entry={active}
          instUrl={instUrl(instName(active.id, slug), domain)}
          frameNonce={frameNonce}
          overlay={overlay}
          containerRef={frameRef}
        />
      ) : (
        <Dashboard
          email={me?.email ?? ""}
          entries={entries.filter(canAccess)}
          openIds={openIds}
          statusById={statusById}
          startingId={startingId}
          query={query}
          onQuery={setQuery}
          onConnect={connect}
          onRestart={restart}
          onEnd={endWorkspace}
          error={error}
        />
      )}
    </div>
  )
}

export default App
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
  baseDomain,
  createWorkspace,
  endWorkspace as apiEndWorkspace,
  fetchCatalog,
  fetchMe,
  listWorkspaces,
  restartWorkspace as apiRestartWorkspace,
  type CatalogEntry,
  type Me,
  type SessionStatus,
  type Workspace,
} from "@/lib/workplace"
import { Dashboard } from "@/views/Dashboard"
import { SessionView, type OverlayState } from "@/views/SessionView"

const FALLBACK_ICON: Record<string, string> = { desktop: "🖥️", app: "🧩" }

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  // Open workspaces (per-user instances) + which one is shown in the frame.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
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

  const teardownAll = async () => {
    try {
      const ws = await listWorkspaces()
      await Promise.allSettled(ws.map((w) => apiEndWorkspace(w.id)))
    } catch {
      // best effort
    }
    localStorage.removeItem("chacdn-active")
    setWorkspaces([])
    setStatusById({})
    setActiveId(null)
    setOverlay(null)
  }

  // Identity + catalog via the workplace API.
  useEffect(() => {
    ;(async () => {
      try {
        const [m, cat] = await Promise.all([fetchMe(), fetchCatalog()])
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
        await fetchMe()
      } catch {
        await teardownAll()
        window.location.reload()
      }
    }, 60000)
    return () => clearInterval(t)
  }, [me])

  // Restore open sessions from the workplace API (server-side source of
  // truth).  The browser never queries the K8s API for this.
  useEffect(() => {
    if (!me) return
    ;(async () => {
      try {
        const ws = await listWorkspaces()
        const accessible = ws.filter((w) => {
          const entry = entries.find((e) => e.id === w.id)
          return !entry || canAccess(entry)
        })
        setWorkspaces(accessible)
        setStatusById(
          Object.fromEntries(accessible.map((w) => [w.id, w.status]))
        )
        const last = localStorage.getItem("chacdn-active")
        setActiveId(
          last && accessible.some((w) => w.id === last)
            ? last
            : (accessible[0]?.id ?? null)
        )
      } catch {
        // not fatal: start with an empty top bar
      }
    })()
  }, [me, entries])

  // Remember which tab was active so a refresh lands back on it.
  useEffect(() => {
    if (activeId) localStorage.setItem("chacdn-active", activeId)
  }, [activeId])

  // Poll the live status of open workspaces so tiles/tabs reflect reality
  // (e.g. a pod that died or finished restarting) without a page reload.
  // Uses the workplace API (server-side source of truth).
  useEffect(() => {
    if (!me || workspaces.length === 0) return
    const poll = async () => {
      try {
        const ws = await listWorkspaces()
        const wsById = new Map(ws.map((w) => [w.id, w]))
        // Update status for existing workspaces
        setStatusById((prev) => {
          const next = { ...prev }
          for (const w of workspaces) {
            const live = wsById.get(w.id)
            if (live) {
              next[w.id] = live.status
            } else {
              // Workspace disappeared (terminated externally)
              delete next[w.id]
            }
          }
          return next
        })
        // Drop workspaces that no longer exist
        setWorkspaces((prev) => {
          const alive = prev.filter((w) => wsById.has(w.id))
          if (alive.length < prev.length) {
            // Clean up active tab if it was the one that disappeared
            setActiveId((prevActive) =>
              prevActive && !wsById.has(prevActive)
                ? (alive.at(-1)?.id ?? null)
                : prevActive
            )
          }
          return alive
        })
      } catch {
        // transient API error; leave status as-is
      }
    }
    poll()
    const t = setInterval(poll, 15000)
    return () => clearInterval(t)
  }, [me, workspaces])

  const select = (id: string | null) => {
    setOverlay(null)
    setActiveId(id)
  }

  const connect = async (e: CatalogEntry) => {
    setStartingId(e.id)
    setError(null)
    const isVm = e.runtime === "vm-linux" || e.runtime === "vm-windows"
    setOverlay({
      title: `Starting ${e.name}…`,
      detail: isVm
        ? "Booting VM: disk import, cloud-init, container pull (~2-5 min first time)."
        : "Pulling image and provisioning container (~30-60 s).",
    })
    try {
      const ws = await createWorkspace(e.id)

      setWorkspaces((prev) =>
        prev.some((w) => w.id === e.id) ? prev : [...prev, { ...ws, icon: e.icon }]
      )
      setStatusById((prev) => ({ ...prev, [e.id]: ws.status }))
      setOverlay(null)
      setActiveId(e.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setOverlay(null)
    } finally {
      setStartingId(null)
    }
  }

  // Ending a workspace shuts it down (pod + service + route) via the API.
  const endWorkspace = async (id: string) => {
    try {
      await apiEndWorkspace(id)
    } catch {
      // best effort; still drop the tab
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

  const restart = async (e: Workspace) => {
    setRestartingId(e.id)
    const isVm = /vm-/.test(
      entries.find((x) => x.id === e.id)?.runtime ?? ""
    )
    setOverlay({
      title: `Restarting ${e.name}…`,
      detail: isVm
        ? "VM rebooting (~1-3 min: VMI respawn, container restart)."
        : "Re-pulling image and starting a fresh pod (~30-60 s).",
    })
    try {
      await apiRestartWorkspace(e.id)
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
                      {w.icon || FALLBACK_ICON[w.type] || "🧩"}
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
                href={active.url}
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
          entry={{ id: active.id, name: active.name }}
          instUrl={active.url}
          frameNonce={frameNonce}
          overlay={overlay}
          status={statusById[active.id]}
          onRestart={() => restart(active)}
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
          onRestart={(e) => {
            const ws = workspaces.find((w) => w.id === e.id)
            if (ws) restart(ws)
          }}
          onEnd={endWorkspace}
          error={error}
        />
      )}
    </div>
  )
}

export default App
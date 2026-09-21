import { useEffect, useMemo, useRef, useState } from "react"
import {
  ExternalLink,
  FolderOpen,
  LogOut,
  Maximize,
  Monitor,
  Moon,
  RotateCw,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTheme } from "@/components/theme-provider"
import {
  ApiError,
  baseDomain,
  createWorkspace,
  endWorkspace as apiEndWorkspace,
  fetchCatalog,
  fetchMe,
  listWorkspaces,
  restartWorkspace as apiRestartWorkspace,
  touchWorkspace,
  type CatalogEntry,
  type Me,
  type SessionStatus,
  type Workspace,
} from "@/lib/workplace"
import { AdminView } from "@/views/AdminView"
import { FilesView } from "@/views/FilesView"
import { Dashboard } from "@/views/Dashboard"
import { SessionView, type OverlayState } from "@/views/SessionView"

const FALLBACK_ICON: Record<string, string> = { desktop: "🖥️", app: "🧩" }

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  // Only ever "admin" for someone the API calls an admin - and the API checks
  // again on every admin call.
  const [view, setView] = useState<"catalog" | "admin" | "files">("catalog")
  // Whose home the file view is showing; empty = the signed-in user's own.
  const [filesOwner, setFilesOwner] = useState<string>("")

  // Open workspaces (per-user instances) + which one is shown in the frame.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Launches that have not answered yet. The POST only creates the objects
  // (the server used to block for up to 5 minutes), so this is a short-lived
  // "the click registered" marker - the server list takes over from there.
  // A list, not a single id: launching two entries at once is allowed and the
  // second must not erase the first one's "Starting".
  const [pending, setPending] = useState<string[]>([])
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
  const activeIsVm = useMemo(
    () =>
      /vm-/.test(
        entries.find((e) => e.id === active?.id)?.runtime ?? ""
      ),
    [active, entries]
  )

  const teardownAll = async () => {
    try {
      const ws = await listWorkspaces()
      await Promise.allSettled(ws.map((w) => apiEndWorkspace(w.id)))
    } catch {
      // best effort
    }
    localStorage.removeItem("mytops-active")
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
          err instanceof ApiError && (err.message === "not-json" || err.status === 401)
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
  // oauth2-proxy bounce us back to the login page. It takes three consecutive
  // failures: an expired session shows up as a 401/403 from the API or as a
  // CORS failure on the Keycloak redirect (indistinguishable from a dropped
  // connection), and destroying every workspace the user has running because
  // one poll hit a flaky network is far worse than tearing them down a minute
  // later.
  useEffect(() => {
    if (!me) return
    let consecutiveFailures = 0
    const t = setInterval(async () => {
      try {
        await fetchMe()
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures += 1
        const signedOut = err instanceof ApiError && (err.status === 401 || err.status === 403)
        if (signedOut || consecutiveFailures >= 3) {
          await teardownAll()
          window.location.reload()
        }
      }
    }, 30000)
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
          return !entry || !entry.groups?.length || entry.groups.some((g) => myGroups.has(g))
        })
        setWorkspaces(accessible)
        setStatusById(
          Object.fromEntries(accessible.map((w) => [w.id, w.status]))
        )
        // Land on the dashboard, never auto-open a session. Users get to
        // pick the machine each time (an auto-opened iframe that isn't
        // streamReady is exactly the 502 annoyance we fixed).
        setActiveId(null)
      } catch {
        // not fatal: start with an empty top bar
      }
    })()
  }, [me, entries, myGroups])

  // Poll the live status of open workspaces so tiles/tabs reflect reality
  // (a pod that died, a workspace that finished provisioning or was
  // terminated) without a page reload. The server list is the source of
  // truth, so entries are replaced wholesale rather than only having their
  // status refreshed - streamReady and the URL change too.
  useEffect(() => {
    if (!me) return
    const poll = async () => {
      try {
        const ws = await listWorkspaces()
        setWorkspaces((prev) => {
          const gone = prev.filter((w) => !ws.some((s) => s.id === w.id))
          if (gone.length) {
            setActiveId((prevActive) =>
              prevActive && gone.some((d) => d.id === prevActive) ? null : prevActive
            )
          }
          return ws.map((w) => ({ ...w, icon: w.icon ?? prev.find((p) => p.id === w.id)?.icon }))
        })
        setStatusById(Object.fromEntries(ws.map((w) => [w.id, w.status])))
      } catch {
        // transient API error; leave status as-is
      }
    }
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [me])

  // Keep the open workspace alive: an entry may declare how long it may sit
  // unused (idleSuspendMinutes) before the API stops it, and "on screen in my
  // browser" is the only honest signal for that. Hidden tabs stop beating, so
  // a desktop left open overnight is suspended by the time you come back.
  const onScreenId = active?.id ?? null
  useEffect(() => {
    if (!me || !onScreenId) return
    const beat = () => {
      if (!document.hidden) touchWorkspace(onScreenId).catch(() => {})
    }
    beat()
    const t = setInterval(beat, 30000)
    return () => clearInterval(t)
  }, [me, onScreenId])

  const select = (id: string | null) => {
    setOverlay(null)
    setActiveId(id)
    if (id) setView("catalog")
  }

  const connect = async (e: CatalogEntry) => {
    setPending((prev) => (prev.includes(e.id) ? prev : [...prev, e.id]))
    setError(null)
    try {
      const ws = await createWorkspace(e.id)
      setWorkspaces((prev) =>
        prev.some((w) => w.id === e.id) ? prev : [...prev, { ...ws, icon: e.icon }]
      )
      setStatusById((prev) => ({ ...prev, [e.id]: ws.status }))
      setActiveId(e.id)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      setError(`Could not launch ${e.name}: ${detail}`)
    } finally {
      setPending((prev) => prev.filter((id) => id !== e.id))
    }
  }

  // Ending a workspace shuts it down (pod + service + route) via the API.
  const endWorkspace = async (id: string) => {
    try {
      await apiEndWorkspace(id)
      setError(null)
    } catch (err) {
      // The tab still goes away; the poll brings it back if the workspace
      // really is still there, and the banner says why.
      setError(
        `Could not destroy ${id}: ` +
          (err instanceof Error ? err.message : String(err))
      )
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
      const res = await apiRestartWorkspace(e.id)
      // Remount the iframe so it stops showing the old page, then let the
      // poll report when the new pod (or VMI) is actually up.
      setFrameNonce((n) => n + 1)
      setOverlay(null)
      setError(null)
      setStatusById((prev) => ({ ...prev, [e.id]: res.status }))
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      // The overlay only shows while a session is on screen; restarting from
      // a catalog tile needs the dashboard's banner to say what happened.
      setOverlay({ title: "Restart failed", detail })
      setError(`Could not restart ${e.name}: ${detail}`)
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
      `https://keycloak.${domain}/realms/mytops/protocol/openid-connect/logout?client_id=webui&post_logout_redirect_uri=${rd}`
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
          onClick={() => {
            select(null)
            setView("catalog")
          }}
          title="Back to workspace catalog"
          className="flex h-8 shrink-0 items-center gap-2 rounded-md px-2 hover:bg-muted"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <Monitor className="size-4" />
          </span>
          <span className="hidden text-sm font-semibold sm:inline">
            Mytops
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
              status === "running" ? "dot-running"
              : status === "starting" ? "dot-starting"
              : status === "suspended" ? "dot-suspended"
              : "dot-offline"
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
              {activeIsVm ? (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => restart(active)}
                  disabled={restartingId !== null}
                  title="Reboot VM (fresh boot of the same disk)"
                >
                  <RotateCw
                    className={restartingId === active.id ? "animate-spin" : ""}
                  />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Destroy this workspace"
                  onClick={() => endWorkspace(active.id)}
                >
                  <Trash2 />
                </Button>
              )}
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
            variant={view === "files" && !active ? "secondary" : "ghost"}
            onClick={() => {
              select(null)
              if (view === "files") return setView("catalog")
              setFilesOwner("")
              setView("files")
            }}
            title="Your files: browse the home volume without a session"
          >
            <FolderOpen className="size-4" />
          </Button>

          {me?.isAdmin && (
            <Button
              size="icon"
              variant={view === "admin" && !active ? "secondary" : "ghost"}
              onClick={() => {
                select(null)
                setView((v) => (v === "admin" ? "catalog" : "admin"))
              }}
              title="Admin: manage everyone's workspaces"
            >
              <ShieldCheck className="size-4" />
            </Button>
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

      {view === "files" && !active ? (
        <FilesView owner={filesOwner || undefined} />
      ) : view === "admin" && !active ? (
        <AdminView
          onOpenFiles={(owner) => {
            setFilesOwner(owner)
            setView("files")
          }}
        />
      ) : active ? (
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
          pendingIds={pending}
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
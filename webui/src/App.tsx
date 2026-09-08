import { useEffect, useMemo, useState } from "react"
import { Monitor, Play, Search, X } from "lucide-react"
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
  url: string
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

export function App() {
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<EntryType | "all">("all")

  // Open workspaces + which one is shown in the embedded frame. Clicking a
  // catalog card opens/reopens one; the header tabs switch between them.
  const [workspaces, setWorkspaces] = useState<CatalogEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    fetch("catalog.json", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        setEntries(Array.isArray(data.apps) ? data.apps : [])
        setError(null)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter(
      (e) =>
        (filter === "all" || e.type === filter) &&
        (!q ||
          (e.name + " " + (e.description ?? "")).toLowerCase().includes(q))
    )
  }, [entries, query, filter])

  const active = workspaces.find((w) => w.id === activeId) ?? null

  const openWorkspace = (entry: CatalogEntry) => {
    setWorkspaces((prev) =>
      prev.some((w) => w.id === entry.id) ? prev : [...prev, entry]
    )
    setActiveId(entry.id)
  }

  const closeWorkspace = (id: string) => {
    const rest = workspaces.filter((w) => w.id !== id)
    setWorkspaces(rest)
    if (activeId === id) {
      setActiveId(rest.length ? rest[rest.length - 1].id : null)
    }
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      {/* Top bar: brand + one tab per open workspace */}
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
      </header>

      {active ? (
        // Embedded Selkies workspace; only the active one is mounted so the
        // video stream stops when you switch (the desktop pod keeps running).
        <div className="min-h-0 flex-1 bg-black">
          <iframe
            key={active.id}
            src={active.url}
            title={active.name}
            className="block h-full w-full border-0"
            allow="autoplay; clipboard-read; clipboard-write; display-capture; fullscreen; microphone; pointer-lock"
          />
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

            {loading ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Loading catalog…
              </p>
            ) : error ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Could not load catalog: {error}
              </p>
            ) : visible.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Nothing here. Add apps/desktops to the catalog to see them.
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
                        onClick={() => openWorkspace(e)}
                      >
                        {workspaces.some((w) => w.id === e.id)
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
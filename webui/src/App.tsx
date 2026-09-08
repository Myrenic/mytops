import { useEffect, useMemo, useState } from "react"
import { ArrowUpRight, Monitor, Search } from "lucide-react"
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

  return (
    <div className="min-h-svh bg-background">
      <header className="mx-auto w-full max-w-6xl px-6 pt-10 pb-6">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Monitor className="size-5" />
          </div>
          <div>
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              Desktops &amp; Apps
            </h1>
            <p className="text-sm text-muted-foreground">
              Your cloud desktops and apps, right in the browser.
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pb-8 sm:flex-row sm:items-center">
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

      <main className="mx-auto w-full max-w-6xl px-6 pb-16">
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
                  <Badge variant={e.type === "desktop" ? "secondary" : "outline"}>
                    {e.type}
                  </Badge>
                </CardHeader>
                <CardContent className="flex-1 text-sm text-muted-foreground">
                  {e.description}
                </CardContent>
                <CardFooter>
                  <Button asChild className="w-full">
                    <a href={e.url} target="_blank" rel="noopener noreferrer">
                      Connect
                      <ArrowUpRight className="ml-2 size-4" />
                    </a>
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

export default App
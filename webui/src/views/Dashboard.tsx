import { useState } from "react"
import {
  ExternalLink,
  Loader2,
  Play,
  RotateCw,
  Search,
  Trash2,
  X,
} from "lucide-react"
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
import { type CatalogEntry, type SessionStatus } from "@/lib/workplace"

const FALLBACK_ICON: Record<string, string> = { desktop: "🖥️", app: "🧩" }

const TYPE_LABEL: Record<string, string> = { desktop: "Desktop", app: "App" }

const RUNTIME_LABEL: Record<string, string> = {
  container: "Container",
  "vm-linux": "Linux VM",
  "vm-windows": "Windows VM",
}

// Deterministic pastel gradient per entry id so each workspace tile has a
// stable, distinct look without shipping artwork.
function tileGradient(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const a = 200 + (h % 160)
  const b = (a + 55 + ((h >> 8) % 45)) % 360
  return `linear-gradient(135deg, oklch(0.72 0.15 ${a} / 0.30), oklch(0.62 0.13 ${b} / 0.16))`
}

function statusOf(
  entry: CatalogEntry,
  openIds: string[],
  statusById: Record<string, SessionStatus>,
  startingId: string | null
): SessionStatus {
  if (startingId === entry.id) return "starting"
  if (!openIds.includes(entry.id)) return "stopped"
  return statusById[entry.id] ?? "starting"
}

function StatusDot({ status }: { status: SessionStatus }) {
  const cls =
    status === "running"
      ? "dot-running"
      : status === "starting"
        ? "dot-starting"
        : "dot-offline"
  return <span className={`inline-block size-2 shrink-0 rounded-full ${cls}`} />
}

function StatusLabel({ status }: { status: SessionStatus }) {
  const text =
    status === "running"
      ? "Running"
      : status === "starting"
        ? "Starting"
        : "Offline"
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <StatusDot status={status} />
      {text}
    </span>
  )
}

interface TileProps {
  entry: CatalogEntry
  status: SessionStatus
  isOpen: boolean
  onConnect: (e: CatalogEntry) => void
  onRestart: (e: CatalogEntry) => void
  onEnd: (id: string) => void
}

function Tile({ entry, status, isOpen, onConnect, onRestart, onEnd }: TileProps) {
  const [armed, setArmed] = useState(false)
  const icon = entry.icon || FALLBACK_ICON[entry.type]
  const starting = status === "starting"

  const end = () => {
    if (!armed) {
      setArmed(true)
      setTimeout(() => setArmed(false), 2500)
      return
    }
    setArmed(false)
    onEnd(entry.id)
  }

  return (
    <Card className="group/tile flex h-full flex-col overflow-hidden transition-all duration-200 hover:ring-primary/40">
      <div
        className="relative grid h-24 shrink-0 place-items-center"
        style={{ background: tileGradient(entry.id) }}
      >
        <span className="text-5xl drop-shadow-sm">{icon}</span>
        <Badge
          variant="secondary"
          className="absolute top-2 right-2 bg-black/20 text-white backdrop-blur-sm"
        >
          {entry.runtime && RUNTIME_LABEL[entry.runtime]
            ? RUNTIME_LABEL[entry.runtime]
            : TYPE_LABEL[entry.type]}
        </Badge>
      </div>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate">{entry.name}</CardTitle>
          <StatusLabel status={status} />
        </div>
      </CardHeader>
      <CardContent className="flex-1 text-sm text-muted-foreground">
        {starting ? (
          <span className="flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3 animate-spin" />
            {entry.runtime === "vm-linux"
              ? "Booting VM… (~2-5 min: disk import, cloud-init, container pull)"
              : "Pulling image + starting container…"}
          </span>
        ) : (
          entry.description ?? "Remote workspace."
        )}
      </CardContent>
      <CardFooter className="flex gap-2">
        <Button
          className="flex-1"
          onClick={() => onConnect(entry)}
          disabled={starting}
        >
          {starting ? (
            <Loader2 className="animate-spin" />
          ) : isOpen ? (
            <ExternalLink />
          ) : (
            <Play />
          )}
          {starting ? "Launching…" : isOpen ? "Resume" : "Launch"}
        </Button>
        {/* Always visible: a stuck launch or a half-provisioned VM must be
            destroyable even when the API has no live session for it. */}
        <Button
          size="icon"
          variant="outline"
          title={isOpen ? "Restart this workspace with a fresh pod" : "Restart (no running workspace)"}
          onClick={() => isOpen && onRestart(entry)}
        >
          <RotateCw />
        </Button>
        <Button
          size="icon"
          variant="destructive"
          title={
            armed
              ? "Click again to destroy this workspace"
              : "Destroy workspace (also cleans up stale resources)"
          }
          onClick={end}
        >
          {armed ? <X /> : <Trash2 />}
        </Button>
      </CardFooter>
    </Card>
  )
}

interface DashboardProps {
  email: string
  entries: CatalogEntry[]
  openIds: string[]
  statusById: Record<string, SessionStatus>
  startingId: string | null
  query: string
  onQuery: (q: string) => void
  onConnect: (e: CatalogEntry) => void
  onRestart: (e: CatalogEntry) => void
  onEnd: (id: string) => void
  error: string | null
}

export function Dashboard({
  email,
  entries,
  openIds,
  statusById,
  startingId,
  query,
  onQuery,
  onConnect,
  onRestart,
  onEnd,
  error,
}: DashboardProps) {
  const q = query.trim().toLowerCase()
  const filtered = entries.filter((e) =>
    !q || (e.name + " " + (e.description ?? "")).toLowerCase().includes(q)
  )
  const desktops = filtered.filter((e) => e.type === "desktop")
  const apps = filtered.filter((e) => e.type === "app")
  const running = entries.filter((e) =>
    statusById[e.id] === "running" || openIds.includes(e.id)
  ).length

  const name = email.split("@")[0] || "there"
  const hour = new Date().getHours()
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"

  const renderSection = (label: string, items: CatalogEntry[]) => {
    if (!items.length) return null
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {label}{" "}
          <span className="font-normal text-muted-foreground/60">
            {items.length}
          </span>
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((e) => (
            <Tile
              key={e.id}
              entry={e}
              status={statusOf(e, openIds, statusById, startingId)}
              isOpen={openIds.includes(e.id)}
              onConnect={onConnect}
              onRestart={onRestart}
              onEnd={onEnd}
            />
          ))}
        </div>
      </section>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="hero-glow border-b border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {greeting}, <span className="text-primary">{name}</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {running > 0
                ? `${running} workspace${running === 1 ? "" : "s"} active. Pick up where you left off or launch something new.`
                : "No active workspaces. Launch a desktop or app to get started."}
            </p>
          </div>
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search workspaces…"
              className="pl-9"
            />
          </div>
        </div>
      </div>

      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-8">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Could not launch workspace: {error}
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="grid place-items-center gap-3 py-16 text-center">
            <span className="text-4xl">🔍</span>
            <p className="text-sm text-muted-foreground">
              No workspaces match your search.
            </p>
          </div>
        ) : (
          <>
            {renderSection("Desktops", desktops)}
            {renderSection("Apps", apps)}
          </>
        )}
      </div>
    </div>
  )
}
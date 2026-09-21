import { useEffect, useState } from "react"
import { FolderOpen, Loader2, Pause, Play, RefreshCw, Trash2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  adminDestroyWorkspace,
  adminListWorkspaces,
  adminSuspendWorkspace,
  type AdminWorkspace,
} from "@/lib/workplace"

function relativeTime(epoch?: number): string {
  if (!epoch) return "unknown"
  const seconds = Math.max(0, Math.round((Date.now() - epoch) / 1000))
  if (seconds < 90) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

const STATUS_STYLE: Record<string, string> = {
  running: "dot-running",
  starting: "dot-starting",
  suspended: "dot-suspended",
  offline: "dot-offline",
  stopped: "dot-offline",
}

/**
 * Every workspace in the cluster, whoever owns it. Read-only until you say
 * otherwise, and destructive actions name the owner first: the API keeps a
 * user's home volume out of every path that starts here, so "Destroy" throws
 * away a running desktop but never their files.
 */
export function AdminView({ onOpenFiles }: { onOpenFiles: (owner: string) => void }) {
  const [rows, setRows] = useState<AdminWorkspace[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  // Bumped to re-read: the effect below owns the polling, so a manual refresh
  // and an action's follow-up are the same thing (and no setState runs
  // synchronously inside an effect).
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const load = async () => {
      try {
        setRows(await adminListWorkspaces())
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [tick])

  const act = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name)
    setError(null)
    try {
      await action()
      setTick((cur) => cur + 1)
    } catch (err) {
      setError(
        `${name}: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setBusy(null)
      setArmed(null)
    }
  }

  const byOwner = rows.reduce<Record<string, AdminWorkspace[]>>((acc, row) => {
    const key = row.ownerEmail ?? row.owner ?? "(unknown)"
    acc[key] = acc[key] ?? []
    acc[key].push(row)
    return acc
  }, {})

  const suspended = rows.filter((r) => r.status === "suspended").length

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {rows.length} workspace{rows.length === 1 ? "" : "s"} across{" "}
              {Object.keys(byOwner).length} user
              {Object.keys(byOwner).length === 1 ? "" : "s"}
              {suspended ? ` · ${suspended} suspended` : ""}. Home volumes are
              never touched from here.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setTick((cur) => cur + 1)}>
            <RefreshCw className="mr-1.5 size-3.5" />
            Refresh
          </Button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {Object.entries(byOwner).map(([owner, workspaces]) => (
          <Card key={owner}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                {owner}
                <span className="text-xs font-normal text-muted-foreground">
                  {workspaces.length} workspace
                  {workspaces.length === 1 ? "" : "s"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-border/60 p-0">
              {workspaces.map((w) => (
                <div
                  key={w.name}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3"
                >
                  <span
                    className={`inline-block size-2 shrink-0 rounded-full ${
                      STATUS_STYLE[w.status] ?? "dot-offline"
                    }`}
                  />
                  <div className="min-w-40 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {w.entryName}
                      </span>
                      <Badge variant="secondary" className="text-[10px]">
                        {w.runtime === "vm" ? "VM" : "Container"}
                      </Badge>
                      {w.lifecycle && (
                        <span className="text-xs text-muted-foreground">
                          {w.lifecycle}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {w.name}
                    </div>
                  </div>

                  <div className="w-28 text-xs text-muted-foreground">
                    {w.status}
                  </div>
                  <div className="w-40 text-xs text-muted-foreground">
                    active {relativeTime(w.lastActiveAt)}
                  </div>
                  <div className="w-48 font-mono text-xs text-muted-foreground">
                    {w.home
                      ? `${w.home.name} · ${w.home.size} · ${w.home.phase}`
                      : "no home volume"}
                  </div>

                  <div className="flex items-center gap-2">
                    {w.status === "suspended" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy === w.name}
                        onClick={() => act(w.name, () => adminSuspendWorkspace(w.name, false))}
                      >
                        <Play className="mr-1 size-3" />
                        Resume
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy === w.name || w.status === "starting"}
                        onClick={() => act(w.name, () => adminSuspendWorkspace(w.name, true))}
                      >
                        <Pause className="mr-1 size-3" />
                        Suspend
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      title={`Browse ${owner}'s home volume`}
                      onClick={() => onOpenFiles(w.owner)}
                    >
                      <FolderOpen className="mr-1 size-3" />
                      Files
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={busy === w.name}
                      title={
                        armed === w.name
                          ? `Click again to destroy ${w.name} (${owner}'s home volume is kept)`
                          : `Destroy ${w.name} - ${owner}'s files are kept`
                      }
                      onClick={() => {
                        if (armed !== w.name) {
                          setArmed(w.name)
                          setTimeout(() => setArmed((cur) => (cur === w.name ? null : cur)), 3000)
                          return
                        }
                        act(w.name, () => adminDestroyWorkspace(w.name))
                      }}
                    >
                      {busy === w.name ? (
                        <Loader2 className="animate-spin" />
                      ) : armed === w.name ? (
                        <X />
                      ) : (
                        <Trash2 />
                      )}
                      {armed === w.name ? "Confirm destroy" : "Destroy"}
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}

        {rows.length === 0 && !error && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No workspaces anywhere right now.
          </p>
        )}
      </div>
    </div>
  )
}

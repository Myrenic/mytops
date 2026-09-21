import { ExternalLink, Loader2, RotateCw } from "lucide-react"
import type { Ref } from "react"
import { Button } from "@/components/ui/button"
import type { SessionStatus } from "@/lib/workplace"

export interface OverlayState {
  title: string
  detail: string
}

interface SessionEntry {
  id: string
  name: string
}

interface SessionViewProps {
  entry: SessionEntry
  instUrl: string
  frameNonce: number
  overlay: OverlayState | null
  status?: SessionStatus
  onRestart?: () => void
  containerRef?: Ref<HTMLDivElement>
}

export function SessionView({
  entry,
  instUrl,
  frameNonce,
  overlay,
  status,
  onRestart,
  containerRef,
}: SessionViewProps) {
  const isStarting = status === "starting"
  const isOffline = status === "offline" || status === "stopped"
  // The iframe loads while the workspace is still provisioning, so what it
  // holds is Traefik's 502 (or a login redirect) - a page that never retries
  // itself. Remounting on every health transition is what turns "Running" in
  // the tab bar into a desktop on screen.
  const health = isStarting ? "starting" : isOffline ? "offline" : "running"

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 bg-black">
      <iframe
        key={`${entry.id}-${frameNonce}-${health}`}
        src={instUrl}
        title={entry.name}
        className="block h-full w-full border-0"
        allow="autoplay; clipboard-read; clipboard-write; display-capture; fullscreen; microphone; pointer-lock"
      />
      {/* Explicit overlay from parent (launching, restarting, etc.) */}
      {overlay && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/95">
          <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <Loader2 className="size-8 animate-spin text-primary" />
            <div className="space-y-1">
              <p className="text-sm font-medium">{overlay.title}</p>
              <p className="text-xs text-muted-foreground">{overlay.detail}</p>
            </div>
          </div>
        </div>
      )}
      {/* Sanity escape hatch: iframe-embedded Keycloak redirects can be
          blocked by frame policies — open the workspace top-level instead. */}
      <a
        href={instUrl}
        target="_blank"
        rel="noreferrer"
        className="absolute right-3 top-3 z-20 inline-flex size-8 items-center justify-center rounded-md bg-background/80 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Open in new tab"
      >
        <ExternalLink className="size-4" />
      </a>
      {/* Health probe: workspace still starting after iframe loaded */}
      {!overlay && isStarting && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/80">
          <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Reconnecting…</p>
              <p className="text-xs text-muted-foreground">
                Waiting for {entry.name} to become ready.
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Health probe: workspace went offline */}
      {!overlay && isOffline && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/90">
          <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <p className="text-sm font-medium text-destructive">
              Workspace offline
            </p>
            <p className="text-xs text-muted-foreground">
              {entry.name} has stopped or was terminated.
            </p>
            {onRestart && (
              <Button size="sm" onClick={onRestart}>
                <RotateCw className="mr-1.5 size-3.5" />
                Restart
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

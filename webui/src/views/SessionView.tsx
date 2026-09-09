import { Loader2 } from "lucide-react"
import type { Ref } from "react"

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
  containerRef?: Ref<HTMLDivElement>
}

export function SessionView({
  entry,
  instUrl,
  frameNonce,
  overlay,
  containerRef,
}: SessionViewProps) {
  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 bg-black">
      <iframe
        key={`${entry.id}-${frameNonce}`}
        src={instUrl}
        title={entry.name}
        className="block h-full w-full border-0"
        allow="autoplay; clipboard-read; clipboard-write; display-capture; fullscreen; microphone; pointer-lock"
      />
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
    </div>
  )
}
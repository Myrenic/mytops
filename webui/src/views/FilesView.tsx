import { useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  deleteFile,
  fileContentUrl,
  fileUsage,
  listFiles,
  makeDirectory,
  moveFile,
  writeFile,
  type FileEntry,
  type FileTarget,
  type FileUsage,
  type FileListing,
} from "@/lib/workplace"

function human(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  const cut = trimmed.lastIndexOf("/")
  return cut <= 0 ? "/" : trimmed.slice(0, cut)
}

const PREVIEWABLE = /\.(txt|md|log|json|csv|ya?ml|ini|conf|sh|py|js|ts|tsx|html?|css)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

/**
 * The user's home volume, browsable without starting a desktop: the volume is
 * mounted by a per-user agent pod, and the API proxies to it after checking who
 * is asking. Admins can open someone else's home read-only.
 */
export function FilesView({ owner }: { owner?: string }) {
  const target: FileTarget = owner ? { owner } : {}
  const [path, setPath] = useState("/")
  const [listing, setListing] = useState<FileListing | null>(null)
  const [usage, setUsage] = useState<FileUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ entry: FileEntry; text?: string } | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = async (dir: string) => {
    setBusy(true)
    try {
      setListing(await listFiles(dir, target))
      setUsage(await fileUsage(target))
      setError(null)
      setPath(dir)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const targetOwner = owner ?? ""
  useEffect(() => {
    const forOwner = targetOwner ? { owner: targetOwner } : {}
    const run = async () => {
      setBusy(true)
      try {
        setListing(await listFiles("/", forOwner))
        setUsage(await fileUsage(forOwner))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }
    run()
    // Only the target identity matters here; the path is driven by clicks.
  }, [targetOwner])

  const open = async (entry: FileEntry) => {
    const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`
    if (entry.kind === "dir") return load(child)
    if (PREVIEWABLE.test(entry.name)) {
      setPreview({ entry })
      try {
        const res = await fetch(fileContentUrl(child, target, true))
        setPreview({ entry, text: res.ok ? await res.text() : `could not read: HTTP ${res.status}` })
      } catch (err) {
        setPreview({ entry, text: String(err) })
      }
    }
  }

  const upload = async (file: File) => {
    setBusy(true)
    try {
      const child = path === "/" ? `/${file.name}` : `${path}/${file.name}`
      await writeFile(child, file, target)
      await load(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const newFolder = async () => {
    const name = window.prompt("New folder name")
    if (!name) return
    const child = path === "/" ? `/${name}` : `${path}/${name}`
    try {
      await makeDirectory(child, target)
      await load(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const rename = async (entry: FileEntry) => {
    const name = window.prompt("Rename to", entry.name)
    if (!name || name === entry.name) return
    const from = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`
    const to = path === "/" ? `/${name}` : `${path}/${name}`
    try {
      await moveFile(from, to, target)
      await load(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const remove = async (entry: FileEntry) => {
    if (armed !== entry.name) {
      setArmed(entry.name)
      setTimeout(() => setArmed((cur) => (cur === entry.name ? null : cur)), 3000)
      return
    }
    setArmed(null)
    const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`
    try {
      await deleteFile(child, target)
      await load(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const usedPercent = usage && usage.totalBytes
    ? Math.round(((usage.totalBytes - usage.freeBytes) / usage.totalBytes) * 100)
    : 0

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Files{owner ? ` — ${owner}` : ""}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {owner ? "Someone else's home volume (read-only actions are yours to choose)." : "Your home volume — the same files your workspaces see."}
              {usage && usage.totalBytes > 0 && (
                <>
                  {" · "}
                  <HardDrive className="mb-0.5 inline size-3.5" />{" "}
                  {human(usage.totalBytes - usage.freeBytes)} of {human(usage.totalBytes)} used ({usedPercent}%)
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ""
                if (file) upload(file)
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              <Upload className="mr-1.5 size-3.5" />
              Upload
            </Button>
            <Button variant="outline" size="sm" onClick={newFolder}>
              <FolderPlus className="mr-1.5 size-3.5" />
              New folder
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
            {/no home volume/.test(error) && (
              <span className="block pt-1 text-muted-foreground">
                A home volume is created the first time you launch an entry with
                persistence.
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 text-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={path === "/"}
            onClick={() => load(parentOf(path))}
            title="Up one level"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {path}
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border">
          {(listing?.entries.length ?? 0) === 0 && !busy ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              This folder is empty.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {[...(listing?.entries ?? [])]
                .sort((a, b) =>
                  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1
                )
                .map((entry) => {
                  const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`
                  return (
                    <li
                      key={entry.name}
                      className="flex items-center gap-3 px-4 py-2 hover:bg-muted/40"
                    >
                      <button
                        type="button"
                        onClick={() => open(entry)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        {entry.kind === "dir" ? (
                          <Folder className="size-4 shrink-0 text-primary" />
                        ) : (
                          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate text-sm">{entry.name}</span>
                        {entry.kind === "link" && (
                          <span className="text-xs text-muted-foreground">symlink</span>
                        )}
                      </button>
                      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                        {entry.kind === "file" ? human(entry.size) : ""}
                      </span>
                      <span className="hidden w-36 shrink-0 text-right text-xs text-muted-foreground sm:block">
                        {entry.mtime ? new Date(entry.mtime).toLocaleString() : ""}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {entry.kind === "file" && (
                          <a
                            href={fileContentUrl(child, target)}
                            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="Download"
                          >
                            <Download className="size-3.5" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => rename(entry)}
                          title="Rename"
                          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(entry)}
                          title={armed === entry.name ? `Click again to delete ${entry.name}` : "Delete"}
                          className={`grid size-7 place-items-center rounded-md ${
                            armed === entry.name
                              ? "bg-destructive/20 text-destructive"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground"
                          }`}
                        >
                          {armed === entry.name ? <X className="size-3.5" /> : <Trash2 className="size-3.5" />}
                        </button>
                      </span>
                    </li>
                  )
                })}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Uploading writes straight into the volume, so the files are there the
          next time a workspace starts — and a Transfer of a large file streams,
          it does not go through memory.
        </p>
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-30 grid place-items-center bg-background/80 p-6"
          onClick={() => setPreview(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 border-b px-4 py-2">
              <span className="truncate font-mono text-xs">{path === "/" ? `/${preview.entry.name}` : `${path}/${preview.entry.name}`}</span>
              <div className="flex items-center gap-2">
                <a
                  href={fileContentUrl(path === "/" ? `/${preview.entry.name}` : `${path}/${preview.entry.name}`, target)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Download
                </a>
                <Button size="icon-sm" variant="ghost" onClick={() => setPreview(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {preview.text === undefined ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              ) : IMAGE.test(preview.entry.name) ? (
                <img
                  src={fileContentUrl(path === "/" ? `/${preview.entry.name}` : `${path}/${preview.entry.name}`, target, true)}
                  alt={preview.entry.name}
                  className="max-h-[60vh] rounded-md"
                />
              ) : (
                <pre className="text-xs whitespace-pre-wrap">{preview.text}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

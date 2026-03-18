import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  resolveDialogInitialFocus,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { NoteSummary } from '@middleman/protocol'

const MAX_RESULTS = 50
const PATH_BOUNDARY_PATTERN = /[/._\-\s]/

interface NoteSearchPaletteProps {
  notes: NoteSummary[]
  open: boolean
  selectedNotePath: string | null
  onOpenChange: (open: boolean) => void
  onSelectNote: (path: string) => void
  shortcutLabel?: string
}

interface NoteSearchResult {
  note: NoteSummary
  score: number
  matchIndices: number[]
}

/** Strip trailing `.md` / `.markdown` extension for display. */
function displayPath(path: string): string {
  return path.replace(/\.(?:md|markdown)$/i, '')
}

export function NoteSearchPalette({
  notes,
  open,
  selectedNotePath,
  onOpenChange,
  onSelectNote,
  shortcutLabel,
}: NoteSearchPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [activePath, setActivePath] = useState('')
  const deferredQuery = useDeferredValue(query)

  const results = useMemo(() => fuzzySearchNotes(notes, deferredQuery), [notes, deferredQuery])

  useEffect(() => {
    if (!open) {
      return
    }

    setQuery('')
    window.setTimeout(() => {
      inputRef.current?.select()
    }, 0)
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    const nextActivePath =
      (selectedNotePath && results.some((result) => result.note.path === selectedNotePath) ? selectedNotePath : null) ??
      results[0]?.note.path ??
      ''

    setActivePath(nextActivePath)
  }, [open, results, selectedNotePath])

  const handleSelectResult = (path: string) => {
    onSelectNote(path)
    onOpenChange(false)
  }

  const resultsSummary = summarizeResults(results.length, notes.length, deferredQuery)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        initialFocus={(openType) => (resolveDialogInitialFocus(openType) ? inputRef.current : false)}
        className="w-[min(44rem,calc(100%-2rem))] max-w-none gap-0 overflow-hidden border border-border/60 bg-popover/95 p-0 shadow-2xl supports-backdrop-filter:backdrop-blur-xl sm:max-w-[44rem]"
      >
        <DialogTitle className="sr-only">Search notes</DialogTitle>
        <DialogDescription className="sr-only">
          Search note filenames and paths, then press Enter to open a match.
        </DialogDescription>

        <Command
          label="Search notes"
          shouldFilter={false}
          loop
          value={activePath}
          onValueChange={setActivePath}
          className="rounded-none bg-transparent p-0"
        >
          <div className="border-b border-border/50 bg-muted/20">
            <div className="flex items-start justify-between gap-3 px-4 pt-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  Note Search
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Jump to a note by filename, folder, or full path.
                </p>
              </div>
              {shortcutLabel ? (
                <CommandShortcut className="hidden rounded-full border border-border/70 bg-background/75 px-2.5 py-1 text-[10px] sm:inline-flex">
                  {shortcutLabel}
                </CommandShortcut>
              ) : null}
            </div>

            <CommandInput
              ref={inputRef}
              aria-label="Search notes"
              className="font-editor text-[13px]"
              onValueChange={setQuery}
              placeholder="Search notes, folders, and paths…"
              value={query}
            />

            <div className="flex items-center justify-between gap-3 px-4 pb-3 text-[11px] text-muted-foreground">
              <span>{resultsSummary}</span>
              <span className="hidden sm:inline">Enter to open, arrow keys to move</span>
            </div>
          </div>

          <CommandList className="max-h-[min(26rem,60vh)] px-2 py-2">
            <CommandEmpty>
              <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
                <div className="flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/50">
                  <Search className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-popover-foreground/80">No matching notes</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try a shorter filename fragment or part of the path.
                  </p>
                </div>
              </div>
            </CommandEmpty>

            {results.length > 0 ? (
              <CommandGroup
                heading={
                  <div className="px-2 pb-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                    {resultsSummary}
                  </div>
                }
                className="p-0"
              >
                {results.map((result) => {
                  const isCurrentNote = result.note.path === selectedNotePath
                  const isActive = result.note.path === activePath
                  const { basename, basenameOffset, directory } = splitDisplayPath(result.note.path)

                  return (
                    <CommandItem
                      key={result.note.path}
                      value={result.note.path}
                      className="mx-2"
                      onSelect={() => handleSelectResult(result.note.path)}
                    >
                      <div
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50 text-muted-foreground transition-colors group-data-[selected=true]/command-item:border-accent-foreground/15 group-data-[selected=true]/command-item:bg-background/25 group-data-[selected=true]/command-item:text-accent-foreground',
                        )}
                      >
                        <FileText className="size-4" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate font-editor text-[13px] leading-tight text-foreground group-data-[selected=true]/command-item:text-accent-foreground',
                            )}
                          >
                            <HighlightedText
                              matchClassName={cn(
                                'font-semibold',
                                isActive ? 'text-accent-foreground' : 'text-foreground',
                              )}
                              matchIndices={result.matchIndices}
                              offset={basenameOffset}
                              text={basename}
                            />
                          </span>

                          {isCurrentNote ? (
                            <Badge
                              variant="outline"
                              className="h-5 shrink-0 rounded-full border-border/60 bg-background/70 px-1.5 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase group-data-[selected=true]/command-item:border-accent-foreground/15 group-data-[selected=true]/command-item:bg-background/20 group-data-[selected=true]/command-item:text-accent-foreground/80"
                            >
                              Open
                            </Badge>
                          ) : null}
                        </div>

                        <div className="mt-1 min-w-0 truncate text-[11px] text-muted-foreground group-data-[selected=true]/command-item:text-accent-foreground/75">
                          {directory ? (
                            <>
                              <span className="mr-1 opacity-70">in</span>
                              <HighlightedText
                                matchClassName={cn(
                                  'font-medium',
                                  isActive ? 'text-accent-foreground/85' : 'text-foreground/80',
                                )}
                                matchIndices={result.matchIndices}
                                text={directory}
                              />
                            </>
                          ) : (
                            'Workspace root'
                          )}
                        </div>
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null}
          </CommandList>

          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
            <ShortcutHint keys="Enter" label="open" />
            <ShortcutHint keys="↑↓" label="navigate" />
            <ShortcutHint keys="Esc" label="close" />
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function HighlightedText({
  text,
  matchIndices,
  matchClassName,
  offset = 0,
}: {
  text: string
  matchIndices: number[]
  matchClassName: string
  offset?: number
}) {
  if (text.length === 0) {
    return null
  }

  const highlightedIndices = new Set(matchIndices)

  return text.split('').map((character, index) => (
    <span
      key={`${text}-${offset + index}`}
      className={highlightedIndices.has(offset + index) ? matchClassName : undefined}
    >
      {character}
    </span>
  ))
}

function ShortcutHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-2 py-1">
      <kbd className="font-sans text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground">{keys}</kbd>
      <span>{label}</span>
    </span>
  )
}

function splitDisplayPath(path: string): { basename: string; basenameOffset: number; directory: string | null } {
  const normalizedPath = displayPath(path)
  const basenameOffset = normalizedPath.lastIndexOf('/') + 1

  return {
    basename: normalizedPath.slice(basenameOffset),
    basenameOffset,
    directory: basenameOffset > 0 ? normalizedPath.slice(0, basenameOffset - 1) : null,
  }
}

function summarizeResults(resultCount: number, noteCount: number, query: string): string {
  if (query.trim().length === 0) {
    const visibleCount = Math.min(noteCount, MAX_RESULTS)
    return noteCount > MAX_RESULTS ? `Showing ${visibleCount} of ${noteCount} notes` : `${visibleCount} notes`
  }

  return resultCount === 1 ? '1 matching note' : `${resultCount} matching notes`
}

export function fuzzySearchNotes(notes: NoteSummary[], query: string): NoteSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return notes.slice(0, MAX_RESULTS).map((note) => ({
      note,
      score: 0,
      matchIndices: [],
    }))
  }

  return notes
    .map((note) => {
      const match = scoreNotePathMatch(note.path, normalizedQuery)
      if (!match) {
        return null
      }

      return {
        note,
        score: match.score,
        matchIndices: match.matchIndices,
      }
    })
    .filter((result): result is NoteSearchResult => result !== null)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      if (left.note.path.length !== right.note.path.length) {
        return left.note.path.length - right.note.path.length
      }

      return left.note.path.localeCompare(right.note.path)
    })
    .slice(0, MAX_RESULTS)
}

function scoreNotePathMatch(
  path: string,
  normalizedQuery: string,
): { score: number; matchIndices: number[] } | null {
  const normalizedPath = path.toLowerCase()
  const basenameStart = normalizedPath.lastIndexOf('/') + 1
  const normalizedBasename = normalizedPath.slice(basenameStart)

  let score = 0
  let searchFrom = 0
  let previousIndex = -1
  const matchIndices: number[] = []

  if (normalizedPath === normalizedQuery) {
    score += 160
  } else if (normalizedBasename === normalizedQuery) {
    score += 130
  }

  if (normalizedPath.includes(normalizedQuery)) {
    score += 60
  }

  if (normalizedBasename.includes(normalizedQuery)) {
    score += 45
  }

  if (normalizedBasename.startsWith(normalizedQuery)) {
    score += 24
  }

  for (const character of normalizedQuery) {
    const matchIndex = normalizedPath.indexOf(character, searchFrom)
    if (matchIndex === -1) {
      return null
    }

    matchIndices.push(matchIndex)
    score += 12

    if (matchIndex === previousIndex + 1) {
      score += 18
    }

    if (matchIndex >= basenameStart) {
      score += 8
    }

    const previousCharacter = normalizedPath[matchIndex - 1]
    if (matchIndex === 0 || PATH_BOUNDARY_PATTERN.test(previousCharacter)) {
      score += 14
    }

    score -= Math.max(matchIndex - searchFrom, 0)
    previousIndex = matchIndex
    searchFrom = matchIndex + 1
  }

  score += Math.max(18 - path.length / 4, 0)

  return { score, matchIndices }
}

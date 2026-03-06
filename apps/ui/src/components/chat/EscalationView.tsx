import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowLeft, CalendarDays, ListTodo, PanelLeft, UserRound, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, UserEscalation } from '@middleman/protocol'

interface EscalationViewProps {
  escalations: UserEscalation[]
  managers: AgentDescriptor[]
  onBack: () => void
  onResolveEscalation: (input: {
    escalationId: string
    choice: string
    isCustom: boolean
  }) => Promise<void>
  onToggleMobileSidebar: () => void
}

export function EscalationView({
  escalations,
  managers,
  onBack,
  onResolveEscalation,
  onToggleMobileSidebar,
}: EscalationViewProps) {
  const [selectedEscalationId, setSelectedEscalationId] = useState<string | null>(null)
  const [submittingEscalationId, setSubmittingEscalationId] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [selectedOptionByEscalationId, setSelectedOptionByEscalationId] = useState<Record<string, string>>({})
  const [customResponseByEscalationId, setCustomResponseByEscalationId] = useState<Record<string, string>>({})

  const managerNameById = useMemo(
    () => new Map(managers.map((manager) => [manager.agentId, manager.displayName || manager.agentId])),
    [managers],
  )

  const sortedEscalations = useMemo(
    () => [...escalations].sort(compareEscalations),
    [escalations],
  )
  const selectedEscalation = useMemo(
    () => sortedEscalations.find((escalation) => escalation.id === selectedEscalationId) ?? null,
    [selectedEscalationId, sortedEscalations],
  )
  const openEscalationCount = sortedEscalations.filter((escalation) => escalation.status === 'open').length

  useEffect(() => {
    if (sortedEscalations.length === 0) {
      setSelectedEscalationId(null)
      return
    }

    if (!selectedEscalationId || !sortedEscalations.some((escalation) => escalation.id === selectedEscalationId)) {
      setSelectedEscalationId(sortedEscalations[0]?.id ?? null)
    }
  }, [selectedEscalationId, sortedEscalations])

  useEffect(() => {
    setSubmitError(null)
  }, [selectedEscalationId])

  const selectedOption = selectedEscalation ? selectedOptionByEscalationId[selectedEscalation.id] ?? '' : ''
  const customResponse = selectedEscalation ? customResponseByEscalationId[selectedEscalation.id] ?? '' : ''
  const trimmedCustomResponse = customResponse.trim()
  const isResolved = selectedEscalation?.status === 'resolved'
  const isSubmitting = selectedEscalation ? submittingEscalationId === selectedEscalation.id : false
  const canSubmit = Boolean(selectedEscalation && !isResolved && !isSubmitting && (trimmedCustomResponse || selectedOption))

  const handleSubmit = async () => {
    if (!selectedEscalation || !canSubmit) {
      return
    }

    const isCustom = trimmedCustomResponse.length > 0
    const choice = isCustom ? trimmedCustomResponse : selectedOption

    setSubmittingEscalationId(selectedEscalation.id)
    setSubmitError(null)

    try {
      await onResolveEscalation({
        escalationId: selectedEscalation.id,
        choice,
        isCustom,
      })
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to resolve escalation.')
    } finally {
      setSubmittingEscalationId((current) => (current === selectedEscalation.id ? null : current))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="mb-2 flex h-[62px] shrink-0 items-center justify-between border-b border-border/50 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={onToggleMobileSidebar}
            aria-label="Open sidebar"
          >
            <PanelLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-foreground">Needs Your Attention</h1>
              <span className="text-xs tabular-nums text-muted-foreground">
                {openEscalationCount > 0 ? `${openEscalationCount} open` : `${sortedEscalations.length} total`}
              </span>
            </div>
            <p className="text-[11px] leading-tight text-muted-foreground/70">
              Agent decisions, blockers, and approvals
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          Back
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            {sortedEscalations.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <ListTodo className="mx-auto mb-3 size-5 text-muted-foreground/40" />
                <p className="text-sm font-medium text-foreground/70">No escalations</p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  When agents need a decision, approval, or blocker resolution, it will appear here.
                </p>
              </div>
            ) : (
              <div>
                {sortedEscalations.map((escalation) => {
                  const managerName = managerNameById.get(escalation.managerId) ?? escalation.managerId
                  const isSelected = selectedEscalationId === escalation.id

                  return (
                    <button
                      key={escalation.id}
                      type="button"
                      onClick={() => {
                        setSelectedEscalationId(escalation.id)
                        setSubmitError(null)
                      }}
                      className={cn(
                        'flex w-full items-start gap-3 border-b border-border/30 px-4 py-3 text-left transition-colors duration-100',
                        isSelected ? 'bg-muted/50' : 'hover:bg-muted/25',
                      )}
                    >
                      <StatusPill status={escalation.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-foreground">{escalation.title}</div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/70">
                          <span className="truncate">{managerName}</span>
                          <span className="shrink-0">&middot;</span>
                          <span className="truncate font-mono text-[10px]">{escalation.id}</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        {selectedEscalation ? (
          <button
            type="button"
            className="fixed inset-0 z-20 bg-black/20 backdrop-blur-[1px] md:hidden"
            aria-label="Close escalation details"
            onClick={() => setSelectedEscalationId(null)}
          />
        ) : null}

        <aside
          className={cn(
            'fixed inset-y-0 right-0 z-30 w-full max-w-[34rem] border-l border-border/40 bg-background transition-transform duration-150 ease-out md:static md:z-0 md:max-w-none md:overflow-hidden md:transition-[width,transform]',
            selectedEscalation ? 'translate-x-0 md:w-[28rem]' : 'translate-x-full md:w-0',
          )}
        >
          {selectedEscalation ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={selectedEscalation.status} />
                    <span className="truncate text-[11px] text-muted-foreground/70">
                      {managerNameById.get(selectedEscalation.managerId) ?? selectedEscalation.managerId}
                    </span>
                  </div>
                  <h2 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                    {selectedEscalation.title}
                  </h2>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSelectedEscalationId(null)}
                  aria-label="Close escalation details"
                  className="mt-0.5 shrink-0 text-muted-foreground/60 hover:text-foreground"
                >
                  <X className="size-4" />
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-4 border-t border-border/30 px-5 py-3 text-[12px] text-muted-foreground/70">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="size-3" />
                  {formatDateTime(selectedEscalation.createdAt)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <UserRound className="size-3" />
                  {managerNameById.get(selectedEscalation.managerId) ?? selectedEscalation.managerId}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground/60">{selectedEscalation.id}</span>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <section className="border-t border-border/30 px-5 py-4">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
                    Description
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">
                    {selectedEscalation.description}
                  </p>
                </section>

                <section className="border-t border-border/30 px-5 py-4">
                  <div className="mb-3 flex items-center gap-2">
                    <AlertCircle className="size-3 text-muted-foreground/50" />
                    <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
                      Response
                    </p>
                  </div>

                  {isResolved ? (
                    <ResolvedEscalationResponse escalation={selectedEscalation} />
                  ) : (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        {selectedEscalation.options.map((option) => {
                          const isSelected = selectedOption === option

                          return (
                            <Button
                              key={option}
                              type="button"
                              variant={isSelected ? 'default' : 'outline'}
                              className={cn(
                                'h-auto w-full justify-start whitespace-normal px-3 py-2 text-left text-sm',
                                !isSelected && 'bg-background',
                              )}
                              onClick={() =>
                                setSelectedOptionByEscalationId((current) => ({
                                  ...current,
                                  [selectedEscalation.id]: option,
                                }))
                              }
                              disabled={isSubmitting}
                            >
                              {option}
                            </Button>
                          )
                        })}
                      </div>

                      <div className="space-y-2">
                        <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
                          Custom response
                        </p>
                        <Textarea
                          value={customResponse}
                          onChange={(event) =>
                            setCustomResponseByEscalationId((current) => ({
                              ...current,
                              [selectedEscalation.id]: event.target.value,
                            }))
                          }
                          placeholder="Add a custom response if none of the options fit."
                          rows={4}
                          className="resize-none border-none bg-muted/30 text-sm shadow-none placeholder:text-muted-foreground/40 focus-visible:ring-1 focus-visible:ring-border"
                          disabled={isSubmitting}
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[11px] text-muted-foreground/60">
                          {trimmedCustomResponse
                            ? 'Custom response will be submitted.'
                            : selectedOption
                              ? 'Selected option will be submitted.'
                              : 'Choose an option or enter a custom response.'}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          onClick={() => {
                            void handleSubmit()
                          }}
                          disabled={!canSubmit}
                        >
                          {isSubmitting ? 'Submitting…' : 'Submit response'}
                        </Button>
                      </div>

                      {submitError ? <p className="text-[11px] text-destructive">{submitError}</p> : null}
                    </div>
                  )}
                </section>
              </ScrollArea>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

function ResolvedEscalationResponse({ escalation }: { escalation: UserEscalation }) {
  const responseText = escalation.response?.choice ?? 'Resolved by agent'
  const responseBadgeLabel = escalation.response?.isCustom ? 'Custom response' : 'Selected option'

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-4">
      {escalation.response ? (
        <Badge variant="outline" className="mb-3 border-current/20 bg-background/60 text-[10px]">
          {responseBadgeLabel}
        </Badge>
      ) : null}
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{responseText}</p>
      {escalation.resolvedAt ? (
        <p className="mt-3 text-[11px] text-muted-foreground/60">
          Resolved {formatDateTime(escalation.resolvedAt)}
        </p>
      ) : null}
    </div>
  )
}

function StatusPill({ status }: { status: UserEscalation['status'] }) {
  return (
    <span
      className={cn(
        'mt-0.5 inline-flex h-6 min-w-[4.75rem] items-center justify-center rounded-full px-2 text-[10px] font-medium uppercase tracking-wide',
        status === 'open'
          ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
          : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
      )}
    >
      {status}
    </span>
  )
}

function StatusBadge({ status }: { status: UserEscalation['status'] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'border-current/20 bg-background/60 text-[10px] uppercase tracking-wide',
        status === 'open'
          ? 'text-amber-700 dark:text-amber-300'
          : 'text-emerald-700 dark:text-emerald-300',
      )}
    >
      {status}
    </Badge>
  )
}

function compareEscalations(left: UserEscalation, right: UserEscalation): number {
  if (left.status !== right.status) {
    return left.status === 'open' ? -1 : 1
  }

  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt)
  }

  return right.id.localeCompare(left.id)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

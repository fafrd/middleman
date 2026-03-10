import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { UserEscalation } from '@middleman/protocol'

interface PinnedEscalationsProps {
  escalations: UserEscalation[]
  onEscalationClick: (escalation: UserEscalation) => void
}

export function PinnedEscalations({
  escalations,
  onEscalationClick,
}: PinnedEscalationsProps) {
  const openEscalations = escalations.filter((escalation) => escalation.status === 'open')

  if (openEscalations.length === 0) {
    return null
  }

  return (
    <div className="border-b border-border/70 bg-muted/[0.18]">
      <ScrollArea className="w-full whitespace-nowrap">
        <div
          className="flex min-w-max items-center gap-2 px-3 py-2"
          role="list"
          aria-label="Open escalations"
        >
          {openEscalations.map((escalation) => (
            <Button
              key={escalation.id}
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                'h-8 max-w-64 shrink-0 justify-start gap-2 overflow-hidden rounded-full border-amber-500/25',
                'bg-background/85 px-3 text-xs font-medium text-foreground shadow-sm',
                'hover:border-amber-500/40 hover:bg-background',
              )}
              onClick={() => onEscalationClick(escalation)}
              title={escalation.title}
            >
              <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
              <span className="min-w-0 truncate">{escalation.title}</span>
            </Button>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

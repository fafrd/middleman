import { CircleDashed } from 'lucide-react'
import { AgentStatusIndicator } from '@/components/chat/AgentStatusIndicator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { AgentStatus } from '@middleman/protocol'

type DisplayAgentStatus = AgentStatus | 'reconnecting' | null
type AgentActivityIndicatorSize = 'sm' | 'md'

interface AgentActivityIndicatorProps {
  status: DisplayAgentStatus
  streamingWorkerCount?: number
  size?: AgentActivityIndicatorSize
  selected?: boolean
  className?: string
  ariaLabel?: string
}

const STREAMING_WORKER_CLASS_NAMES: Record<
  AgentActivityIndicatorSize,
  { container: string; icon: string; text: string }
> = {
  sm: {
    container: 'size-3.5',
    icon: 'size-3.5',
    text: 'text-[7px]',
  },
  md: {
    container: 'size-5',
    icon: 'size-5',
    text: 'text-[9px]',
  },
}

export function AgentActivityIndicator({
  status,
  streamingWorkerCount,
  size = 'sm',
  selected = false,
  className,
  ariaLabel,
}: AgentActivityIndicatorProps) {
  if (streamingWorkerCount && streamingWorkerCount > 0) {
    const sizeClassNames = STREAMING_WORKER_CLASS_NAMES[size]

    return (
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  'relative inline-flex shrink-0 items-center justify-center',
                  sizeClassNames.container,
                  className,
                )}
              />
            }
            aria-label={
              ariaLabel ??
              `${streamingWorkerCount} active worker${streamingWorkerCount !== 1 ? 's' : ''}`
            }
          >
            <CircleDashed
              className={cn(
                'absolute inset-0 animate-spin',
                sizeClassNames.icon,
                selected
                  ? 'text-sidebar-accent-foreground/80'
                  : 'text-muted-foreground',
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                'relative font-bold leading-none',
                sizeClassNames.text,
                selected
                  ? 'text-sidebar-accent-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {streamingWorkerCount}
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            sideOffset={6}
            className="px-2 py-1 text-[10px]"
          >
            {streamingWorkerCount} worker{streamingWorkerCount !== 1 ? 's' : ''}{' '}
            active
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <AgentStatusIndicator
      status={status}
      size={size}
      className={className}
      ariaLabel={ariaLabel}
    />
  )
}

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { inferModelPreset } from '@/lib/model-preset'
import { cn } from '@/lib/utils'
import type { AgentDescriptor, ManagerModelPreset } from '@middleman/protocol'

interface AgentRuntimeBadgeProps {
  agent: AgentDescriptor
  selected?: boolean
  className?: string
}

function ClaudeCodeIconPair({ className }: { className?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      <img
        src="/agents/claude-logo.svg"
        alt=""
        className={cn('size-3 shrink-0 object-contain', className)}
      />
      <img
        src="/agents/claude-logo.svg"
        alt=""
        className={cn('size-3 shrink-0 object-contain opacity-70', className)}
      />
    </span>
  )
}

function RuntimeIcon({
  agent,
  className,
}: {
  agent: AgentDescriptor
  className?: string
}) {
  const provider = agent.model.provider.toLowerCase()
  const preset = inferModelPreset(agent)

  if (preset === 'pi-opus') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img
          src="/pi-logo.svg"
          alt=""
          className={cn(
            'size-3 shrink-0 object-contain dark:invert',
            className,
          )}
        />
        <img
          src="/agents/claude-logo.svg"
          alt=""
          className={cn('size-3 shrink-0 object-contain', className)}
        />
      </span>
    )
  }

  if (preset === 'pi-codex') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img
          src="/pi-logo.svg"
          alt=""
          className={cn(
            'size-3 shrink-0 object-contain dark:invert',
            className,
          )}
        />
        <img
          src="/agents/codex-logo.svg"
          alt=""
          className={cn(
            'size-3 shrink-0 object-contain dark:invert',
            className,
          )}
        />
      </span>
    )
  }

  if (preset === 'codex-app') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img
          src="/agents/codex-app-logo.svg"
          alt=""
          className={cn(
            'size-3 shrink-0 object-contain dark:invert',
            className,
          )}
        />
        <img
          src="/agents/codex-logo.svg"
          alt=""
          className={cn(
            'size-3 shrink-0 object-contain dark:invert',
            className,
          )}
        />
      </span>
    )
  }

  if (preset === 'claude-code' || provider === 'anthropic-claude-code') {
    return <ClaudeCodeIconPair className={className} />
  }

  if (provider.includes('anthropic') || provider.includes('claude')) {
    return (
      <img
        src="/agents/claude-logo.svg"
        alt=""
        aria-hidden="true"
        className={className}
      />
    )
  }

  if (provider.includes('openai')) {
    return (
      <img
        src="/agents/codex-logo.svg"
        alt=""
        aria-hidden="true"
        className={cn('dark:invert', className)}
      />
    )
  }

  return (
    <span
      className={cn('inline-block size-1.5 rounded-full bg-current', className)}
      aria-hidden="true"
    />
  )
}

function getModelLabel(
  agent: AgentDescriptor,
  preset: ManagerModelPreset | undefined,
): string {
  if (preset === 'pi-opus') {
    return 'opus'
  }

  if (preset === 'pi-codex' || preset === 'codex-app') {
    return 'codex'
  }

  if (preset === 'claude-code') {
    return 'claude-code'
  }

  const modelId = agent.model.modelId.trim().toLowerCase()

  if (modelId.startsWith('claude-opus')) {
    return 'opus'
  }

  if (modelId.includes('codex')) {
    return 'codex'
  }

  return agent.model.modelId
}

export function AgentRuntimeBadge({
  agent,
  selected = false,
  className,
}: AgentRuntimeBadgeProps) {
  const preset = inferModelPreset(agent)
  const modelLabel = getModelLabel(agent, preset)
  const modelDescription = `${agent.model.provider}/${agent.model.modelId}`

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                'inline-flex h-5 w-8 shrink-0 items-center justify-center rounded-sm border border-sidebar-border/80 bg-sidebar-accent/40 px-0.5',
                selected
                  ? 'border-sidebar-ring/60 bg-sidebar-accent-foreground/10'
                  : '',
                className,
              )}
            />
          }
        >
          <RuntimeIcon
            agent={agent}
            className="size-3 shrink-0 object-contain opacity-90"
          />
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={6}
          className="px-2 py-1 text-[10px]"
        >
          <p className="font-medium">{modelLabel}</p>
          <p className="opacity-80">{modelDescription}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

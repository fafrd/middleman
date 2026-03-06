import { useEffect, useMemo } from 'react'
import { resolveManagerFaviconEmoji, setDocumentFavicon } from '@/lib/favicon'
import type { AgentContextUsage, AgentDescriptor, AgentStatus } from '@middleman/protocol'

interface UseDynamicFaviconOptions {
  managerId: string | null
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
}

export function useDynamicFavicon({
  managerId,
  agents,
  statuses,
}: UseDynamicFaviconOptions): void {
  const faviconEmoji = useMemo(
    () => resolveManagerFaviconEmoji(managerId, agents, statuses),
    [agents, managerId, statuses],
  )

  useEffect(() => {
    setDocumentFavicon(faviconEmoji)
  }, [faviconEmoji])
}

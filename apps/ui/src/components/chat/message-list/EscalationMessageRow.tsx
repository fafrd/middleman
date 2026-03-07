import { EscalationCard } from '@/components/chat/EscalationCard'
import type { UserEscalation } from '@middleman/protocol'

interface EscalationMessageRowProps {
  escalation: UserEscalation
  onResolveEscalation?: (input: {
    escalationId: string
    choice: string
    isCustom: boolean
  }) => Promise<void>
  onOpenEscalationsView?: () => void
}

export function EscalationMessageRow({
  escalation,
  onResolveEscalation,
  onOpenEscalationsView,
}: EscalationMessageRowProps) {
  return (
    <EscalationCard
      escalation={escalation}
      variant="chat"
      onResolveEscalation={onResolveEscalation}
      onOpenEscalationsView={onOpenEscalationsView}
    />
  )
}

import { memo } from 'react'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import type { AgentMessageEntry } from './types'

export const AgentMessageRow = memo(function AgentMessageRow({
  message,
}: {
  message: AgentMessageEntry
}) {
  const fromLabel =
    message.source === 'user_to_agent' ? 'User' : message.fromAgentId?.trim() || 'Agent'
  const toLabel = message.toAgentId.trim() || 'Unknown'
  const normalizedText = message.text.trim()
  const attachmentCount = message.attachmentCount ?? 0
  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  const deliveryLabel =
    message.requestedDelivery || message.acceptedMode
      ? [
          message.requestedDelivery ? `requested ${message.requestedDelivery}` : null,
          message.acceptedMode ? `accepted ${message.acceptedMode}` : null,
        ]
          .filter(Boolean)
          .join(' • ')
      : null

  return (
    <div className="border-l border-[var(--chat-exec-border)] pl-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-[0.14em] text-[var(--chat-exec-muted)]">
        <span>{fromLabel}</span>
        <span aria-hidden="true">→</span>
        <span>{toLabel}</span>
        {deliveryLabel ? <span className="normal-case tracking-normal">{deliveryLabel}</span> : null}
      </div>

      {normalizedText ? (
        <p className="mt-1 text-size-chat whitespace-pre-wrap break-words text-[var(--chat-exec-muted-strong)]">
          {normalizedText}
        </p>
      ) : attachmentCount > 0 ? null : (
        <p className="mt-1 text-size-chat-sm italic text-[var(--chat-exec-muted)]">
          Empty message
        </p>
      )}

      {attachmentCount > 0 ? (
        <p className="mt-1 text-size-chat-sm text-[var(--chat-exec-muted)]">
          Sent {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
        </p>
      ) : null}

      {timestampLabel || sourceContext ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-size-chat-sm text-[var(--chat-exec-muted)]">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
        </div>
      ) : null}
    </div>
  )
})

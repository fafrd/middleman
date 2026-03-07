/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserEscalation } from '@middleman/protocol'
import { EscalationCard } from './EscalationCard'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
})

function buildEscalation(overrides: Partial<UserEscalation> = {}): UserEscalation {
  return {
    id: 'esc-1',
    managerId: 'manager',
    title: 'Approve the deploy?',
    description: 'Production checks are green and waiting for approval.',
    options: ['Approve', 'Hold'],
    status: 'open',
    createdAt: '2026-03-06T12:00:00.000Z',
    ...overrides,
  }
}

describe('EscalationCard', () => {
  it('submits a selected option as an escalation response', async () => {
    const onResolveEscalation = vi.fn().mockResolvedValue(undefined)
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        createElement(EscalationCard, {
          escalation: buildEscalation(),
          onResolveEscalation,
        }),
      )
    })

    flushSync(() => {
      fireEvent.click(getByText(container, 'Approve'))
    })
    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Send response' }))
    })

    await vi.waitFor(() => {
      expect(onResolveEscalation).toHaveBeenCalledWith({
        escalationId: 'esc-1',
        choice: 'Approve',
        isCustom: false,
      })
    })
  })
})

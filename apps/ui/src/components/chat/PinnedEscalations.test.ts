/** @vitest-environment jsdom */

import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserEscalation } from '@middleman/protocol'
import { PinnedEscalations } from './PinnedEscalations'

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
    managerId: 'manager-alpha',
    title: 'Review deployment exception handling for the March release',
    description: 'Need a call before proceeding.',
    options: ['Approve', 'Hold'],
    status: 'open',
    createdAt: '2026-03-09T12:00:00.000Z',
    ...overrides,
  }
}

describe('PinnedEscalations', () => {
  it('renders nothing when there are no open escalations', () => {
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        createElement(PinnedEscalations, {
          escalations: [],
          onEscalationClick: vi.fn(),
        }),
      )
    })

    expect(queryByRole(container, 'list', { name: 'Open escalations' })).toBeNull()
  })

  it('omits resolved escalations from the pinned row', () => {
    root = createRoot(container)

    flushSync(() => {
      root?.render(
        createElement(PinnedEscalations, {
          escalations: [
            buildEscalation({
              id: 'esc-resolved',
              status: 'resolved',
              resolvedAt: '2026-03-09T12:05:00.000Z',
            }),
          ],
          onEscalationClick: vi.fn(),
        }),
      )
    })

    expect(queryByRole(container, 'list', { name: 'Open escalations' })).toBeNull()
  })

  it('opens escalation details when a pinned chip is clicked', () => {
    const onEscalationClick = vi.fn()
    root = createRoot(container)

    const escalation = buildEscalation()

    flushSync(() => {
      root?.render(
        createElement(PinnedEscalations, {
          escalations: [escalation],
          onEscalationClick,
        }),
      )
    })

    flushSync(() => {
      fireEvent.click(
        getByRole(container, 'button', {
          name: escalation.title,
        }),
      )
    })

    expect(onEscalationClick).toHaveBeenCalledWith(escalation)
  })
})

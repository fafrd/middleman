/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  crepeInstances: [] as any[],
  resolveNoteImageUrl: vi.fn((_wsUrl: string, src: string) => `resolved:${src}`),
  uploadNoteAttachment: vi.fn(),
}))

vi.mock('@milkdown/crepe', () => {
  class MockSlice {
    constructor(
      readonly content: unknown,
      readonly openStart: number,
      readonly openEnd: number,
    ) {}
  }

  class MockTransaction {
    replacement: unknown = null

    readonly replaceSelection = vi.fn((slice: unknown) => {
      this.replacement = slice
      return this
    })

    readonly scrollIntoView = vi.fn(() => this)
  }

  class MockCrepe {
    static Feature = {
      ImageBlock: 'image-block',
      Placeholder: 'placeholder',
    } as const

    readonly transaction = new MockTransaction()
    readonly view = {
      dispatch: vi.fn(),
      focus: vi.fn(),
      state: {
        selection: {
          $from: {
            parent: {
              textContent: 'existing paragraph',
            },
          },
          content: () => new MockSlice('selection', 0, 0),
        },
        tr: this.transaction,
      },
    }
    readonly editor = {
      action: vi.fn((fn: (ctx: { get: (key: string) => unknown }) => void) =>
        fn({
          get: (key: string) => {
            if (key === 'editorView') {
              return this.view
            }

            if (key === 'parser') {
              return (markdown: string) => ({
                content: { markdown },
              })
            }

            return null
          },
        }),
      ),
    }
    readonly create = vi.fn(async () => {
      const milkdown = document.createElement('div')
      milkdown.className = 'milkdown'

      const proseMirror = document.createElement('div')
      proseMirror.className = 'ProseMirror'
      milkdown.append(proseMirror)

      this.config.root?.append(milkdown)
      return {} as never
    })
    readonly destroy = vi.fn(async () => {
      this.config.root?.replaceChildren()
      return {} as never
    })
    readonly on = vi.fn(
      (register: (listener: { markdownUpdated: (cb: (ctx: unknown, markdown: string, prevMarkdown: string) => void) => void }) => void) => {
        register({
          markdownUpdated: (callback) => {
            this.markdownUpdatedListener = callback
          },
        })

        return this
      },
    )

    markdownUpdatedListener: ((ctx: unknown, markdown: string, prevMarkdown: string) => void) | null = null

    constructor(readonly config: any) {
      mocks.crepeInstances.push(this)
    }

    emitMarkdown(markdown: string, prevMarkdown = '') {
      this.markdownUpdatedListener?.({} as never, markdown, prevMarkdown)
    }
  }

  return {
    Crepe: MockCrepe,
  }
})

vi.mock('./notes-api', () => ({
  resolveNoteImageUrl: mocks.resolveNoteImageUrl,
  uploadNoteAttachment: mocks.uploadNoteAttachment,
}))

import { NotesMarkdownEditor } from './NotesMarkdownEditor'

let container: HTMLDivElement
let root: Root | null = null

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container?.remove()
  mocks.crepeInstances.length = 0
  vi.clearAllMocks()
})

async function mountEditor(props: Parameters<typeof NotesMarkdownEditor>[0]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  flushSync(() => {
    root?.render(createElement(NotesMarkdownEditor, props))
  })

  await flushMicrotasks()
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

describe('NotesMarkdownEditor', () => {
  it('creates a Crepe editor with the initial markdown and placeholder config', async () => {
    await mountEditor({
      editorId: 'note-1',
      markdown: '# Hello',
      onChange: vi.fn(),
      placeholder: 'Write something',
      wsUrl: 'ws://127.0.0.1:47187',
    })

    expect(mocks.crepeInstances).toHaveLength(1)
    expect(container.querySelector('.ProseMirror')).toBeTruthy()

    const instance = mocks.crepeInstances.at(-1)
    expect(instance.config.defaultValue).toBe('# Hello')
    expect(instance.config.featureConfigs?.placeholder).toEqual({
      mode: 'doc',
      text: 'Write something',
    })
  })

  it('publishes markdown updates from Crepe back to the parent', async () => {
    const onChange = vi.fn()

    await mountEditor({
      editorId: 'note-1',
      markdown: '',
      onChange,
      wsUrl: 'ws://127.0.0.1:47187',
    })

    mocks.crepeInstances.at(-1).emitMarkdown('## Updated\n')
    await flushMicrotasks()

    expect(onChange).toHaveBeenCalledWith('## Updated\n')
  })

  it('routes image uploads through the notes API and inserts markdown for pasted images', async () => {
    mocks.uploadNoteAttachment.mockResolvedValue('attachments/cat.png')

    await mountEditor({
      editorId: 'note-1',
      markdown: '',
      onChange: vi.fn(),
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const proseMirror = container.querySelector('.ProseMirror')
    expect(proseMirror).toBeTruthy()

    const file = new File(['image'], 'cat-photo.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [file],
        items: [],
      },
    })

    proseMirror?.dispatchEvent(pasteEvent)
    await flushMicrotasks()

    expect(mocks.uploadNoteAttachment).toHaveBeenCalledWith('ws://127.0.0.1:47187', file)
    expect(pasteEvent.defaultPrevented).toBe(true)
  })

  it('uses the notes image resolver for Crepe image rendering', async () => {
    await mountEditor({
      editorId: 'note-1',
      markdown: '',
      onChange: vi.fn(),
      wsUrl: 'ws://127.0.0.1:47187',
    })

    const imageBlockConfig = mocks.crepeInstances.at(-1).config.featureConfigs?.['image-block']
    const proxyDomURL = imageBlockConfig?.proxyDomURL
    const onUpload = imageBlockConfig?.onUpload
    expect(proxyDomURL).toBeTruthy()
    expect(proxyDomURL?.('attachments/example.png')).toBe('resolved:attachments/example.png')
    expect(mocks.resolveNoteImageUrl).toHaveBeenCalledWith('ws://127.0.0.1:47187', 'attachments/example.png')

    mocks.uploadNoteAttachment.mockResolvedValueOnce('attachments/example.png')
    const file = new File(['image'], 'example.png', { type: 'image/png' })
    await expect(onUpload?.(file)).resolves.toBe('attachments/example.png')
    expect(mocks.uploadNoteAttachment).toHaveBeenCalledWith('ws://127.0.0.1:47187', file)
  })
})

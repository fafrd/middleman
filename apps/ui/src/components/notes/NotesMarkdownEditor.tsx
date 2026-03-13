import { Crepe } from '@milkdown/crepe'
import { Loader2 } from 'lucide-react'
import { memo, startTransition, useEffect, useEffectEvent, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

import { resolveNoteImageUrl, uploadNoteAttachment } from './notes-api'

import './notes-milkdown.css'

interface NotesMarkdownEditorProps {
  editorId: string
  wsUrl: string
  markdown: string
  onChange: (markdown: string) => void
  placeholder?: string
}

const EDITOR_VIEW_CTX = 'editorView'
const PARSER_CTX = 'parser'

const IMAGE_UPLOAD_STATUS_CONTAINER_CLASS_NAME =
  'pointer-events-none absolute right-4 top-4 z-10 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur'

export const NotesMarkdownEditor = memo(function NotesMarkdownEditor({
  editorId,
  wsUrl,
  markdown,
  onChange,
  placeholder = 'Start writing...',
}: NotesMarkdownEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const onChangeRef = useRef(onChange)
  const wsUrlRef = useRef(wsUrl)
  const markdownRef = useRef(markdown)
  const placeholderRef = useRef(placeholder)
  const lastPublishedMarkdownRef = useRef(markdown)

  const [isReady, setIsReady] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [uploadCount, setUploadCount] = useState(0)

  onChangeRef.current = onChange
  wsUrlRef.current = wsUrl
  markdownRef.current = markdown
  placeholderRef.current = placeholder

  const publishMarkdown = useEffectEvent((nextMarkdown: string) => {
    if (nextMarkdown === lastPublishedMarkdownRef.current) {
      return
    }

    lastPublishedMarkdownRef.current = nextMarkdown
    startTransition(() => {
      onChangeRef.current(nextMarkdown)
    })
  })

  const uploadImages = useEffectEvent(async (files: File[]) => {
    if (files.length === 0) {
      return
    }

    setStatusError(null)
    setUploadCount((count) => count + files.length)

    try {
      const snippets: string[] = []

      for (const file of files) {
        const src = await uploadNoteAttachment(wsUrlRef.current, file)
        snippets.push(formatImageMarkdown(resolveImageAltText(file), src))
      }

      insertMarkdownAtSelection(crepeRef.current, snippets.join('\n\n'))
    } catch (error) {
      setStatusError(toErrorMessage(error, 'Unable to upload image.'))
    } finally {
      setUploadCount((count) => Math.max(0, count - files.length))
    }
  })

  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }

    let cancelled = false
    let cleanupInteractions: (() => void) | undefined

    lastPublishedMarkdownRef.current = markdownRef.current
    setIsReady(false)
    setStatusError(null)
    root.replaceChildren()

    const crepe = new Crepe({
      root,
      defaultValue: markdownRef.current,
      featureConfigs: {
        [Crepe.Feature.Placeholder]: {
          mode: 'doc',
          text: placeholderRef.current,
        },
        [Crepe.Feature.ImageBlock]: {
          onUpload: (file) => uploadNoteAttachment(wsUrlRef.current, file),
          proxyDomURL: (url) => resolveNoteImageUrl(wsUrlRef.current, url),
        },
      },
    })

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, nextMarkdown) => {
        publishMarkdown(nextMarkdown)
      })
    })

    crepeRef.current = crepe

    void crepe
      .create()
      .then(() => {
        if (cancelled) {
          return
        }

        const editableElement = root.querySelector('.ProseMirror')
        if (editableElement instanceof HTMLElement) {
          cleanupInteractions = bindImageUploadInteractions(editableElement, uploadImages)
        }

        setIsReady(true)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        setStatusError(toErrorMessage(error, 'Unable to start the editor.'))
      })

    return () => {
      cancelled = true
      cleanupInteractions?.()
      if (crepeRef.current === crepe) {
        crepeRef.current = null
      }
      void crepe.destroy().catch(() => undefined)
    }
  }, [editorId, publishMarkdown, uploadImages])

  const isUploading = uploadCount > 0
  const statusText = isUploading
    ? `Uploading ${uploadCount} image${uploadCount === 1 ? '' : 's'}...`
    : statusError

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {statusText ? (
        <div
          className={cn(
            IMAGE_UPLOAD_STATUS_CONTAINER_CLASS_NAME,
            isUploading
              ? 'border-border/70 bg-background/95 text-foreground'
              : 'border-destructive/20 bg-destructive/10 text-destructive',
          )}
        >
          {isUploading ? <Loader2 className="size-3.5 animate-spin" /> : null}
          <span>{statusText}</span>
        </div>
      ) : null}

      <div className="notes-milkdown-scroll-area min-h-0 flex-1 overflow-y-auto">
        <div className="notes-milkdown-shell mx-auto min-h-full w-full max-w-[980px]">
          <div ref={rootRef} className="min-h-full" />
          {!isReady && !statusError ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/65 backdrop-blur-[2px]">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
})

function bindImageUploadInteractions(
  editableElement: HTMLElement,
  uploadImages: (files: File[]) => Promise<void>,
): () => void {
  const handlePaste = (event: ClipboardEvent) => {
    const imageFiles = extractImageFilesFromPasteEvent(event)
    if (imageFiles.length === 0) {
      return
    }

    event.preventDefault()
    void uploadImages(imageFiles)
  }

  const handleDragOver = (event: DragEvent) => {
    const imageFiles = extractImageFilesFromDataTransfer(event.dataTransfer)
    if (imageFiles.length === 0) {
      return
    }

    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDrop = (event: DragEvent) => {
    const imageFiles = extractImageFilesFromDataTransfer(event.dataTransfer)
    if (imageFiles.length === 0) {
      return
    }

    event.preventDefault()
    editableElement.focus()
    void uploadImages(imageFiles)
  }

  editableElement.addEventListener('paste', handlePaste)
  editableElement.addEventListener('dragover', handleDragOver)
  editableElement.addEventListener('drop', handleDrop)

  return () => {
    editableElement.removeEventListener('paste', handlePaste)
    editableElement.removeEventListener('dragover', handleDragOver)
    editableElement.removeEventListener('drop', handleDrop)
  }
}

function insertMarkdownAtSelection(crepe: Crepe | null, snippet: string): void {
  if (!crepe || snippet.trim().length === 0) {
    return
  }

  crepe.editor.action((ctx: any) => {
    const view = ctx.get(EDITOR_VIEW_CTX)
    const parser = ctx.get(PARSER_CTX) as ((markdown: string) => { content: unknown } | null) | null
    if (!view || typeof parser !== 'function') {
      return
    }

    const selection = view.state.selection
    const parentText = selection?.$from?.parent?.textContent
    const needsLeadingLineBreak = typeof parentText === 'string' && parentText.trim().length > 0
    const markdown = needsLeadingLineBreak ? `\n\n${snippet}\n\n` : `${snippet}\n\n`
    const doc = parser(markdown)
    if (!doc) {
      return
    }

    const currentSlice = selection.content()
    const SliceConstructor = currentSlice.constructor as new (
      content: unknown,
      openStart: number,
      openEnd: number,
    ) => unknown

    view.focus?.()
    view.dispatch(
      view.state.tr
        .replaceSelection(new SliceConstructor(doc.content, currentSlice.openStart, currentSlice.openEnd))
        .scrollIntoView(),
    )
  })
}

function formatImageMarkdown(altText: string, src: string): string {
  return `![${altText.replace(/]/g, '\\]')}](${src})`
}

function extractImageFilesFromPasteEvent(event: ClipboardEvent): File[] {
  return extractImageFilesFromDataTransfer(event.clipboardData)
}

function extractImageFilesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) {
    return []
  }

  const files = Array.from(dataTransfer.files ?? []).filter((file) => file.type.startsWith('image/'))
  if (files.length > 0) {
    return files
  }

  const fallbackFiles: File[] = []
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) {
      continue
    }

    const file = item.getAsFile()
    if (file) {
      fallbackFiles.push(file)
    }
  }

  return fallbackFiles
}

function resolveImageAltText(file: File): string {
  const trimmedName = file.name.trim()
  if (!trimmedName) {
    return 'image'
  }

  const baseName = trimmedName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
  return baseName || 'image'
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return fallback
}

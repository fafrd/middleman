import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent"
import { Hono } from "hono"
import type { SwarmManager } from "../../swarm/swarm-manager.js"
import {
  normalizeMimeType,
  parseMultipartFormData,
  resolveUploadFileName,
} from "../attachment-parser.js"
import { readRequestBody } from "../http-utils.js"
import { createCorsMiddleware, createMethodGuard, type NodeServerEnv } from "../hono-utils.js"

const TRANSCRIBE_ENDPOINT_PATH = "/api/transcribe"
const TRANSCRIBE_METHODS = ["POST"] as const
const MAX_TRANSCRIBE_FILE_BYTES = 4_000_000
const MAX_TRANSCRIBE_BODY_BYTES = MAX_TRANSCRIBE_FILE_BYTES + 512 * 1024
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions"
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"
const OPENAI_TRANSCRIPTION_TIMEOUT_MS = 30_000
const ALLOWED_TRANSCRIBE_MIME_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
])

export function createTranscriptionRoutes(options: { swarmManager: SwarmManager }): Hono<NodeServerEnv> {
  const { swarmManager } = options
  const app = new Hono<NodeServerEnv>()

  app.use(TRANSCRIBE_ENDPOINT_PATH, createCorsMiddleware(TRANSCRIBE_METHODS))
  app.use(TRANSCRIBE_ENDPOINT_PATH, createMethodGuard(TRANSCRIBE_METHODS))
  app.post(TRANSCRIBE_ENDPOINT_PATH, async (c) => {
    const contentType = c.req.header("content-type")
    if (typeof contentType !== "string" || !contentType.toLowerCase().includes("multipart/form-data")) {
      return c.json({ error: "Content-Type must be multipart/form-data" }, 400)
    }

    let rawBody: Buffer
    try {
      rawBody = await readRequestBody(c.req.raw, MAX_TRANSCRIBE_BODY_BYTES)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes("too large")) {
        return c.json({ error: "Audio file too large. Max size is 4MB." }, 413)
      }
      throw error
    }

    const formData = await parseMultipartFormData(rawBody, contentType)
    const fileValue = formData.get("file")

    if (!(fileValue instanceof File)) {
      return c.json({ error: "Missing audio file upload (field name: file)." }, 400)
    }

    if (fileValue.size === 0) {
      return c.json({ error: "Audio file is empty." }, 400)
    }

    if (fileValue.size > MAX_TRANSCRIBE_FILE_BYTES) {
      return c.json({ error: "Audio file too large. Max size is 4MB." }, 413)
    }

    const normalizedMimeType = normalizeMimeType(fileValue.type)
    if (normalizedMimeType && !ALLOWED_TRANSCRIBE_MIME_TYPES.has(normalizedMimeType)) {
      return c.json({ error: "Unsupported audio format." }, 415)
    }

    const apiKey = resolveOpenAiApiKey(swarmManager)
    if (!apiKey) {
      return c.json({ error: "OpenAI API key required — add it in Settings." }, 400)
    }

    const payload = new FormData()
    payload.set("model", OPENAI_TRANSCRIPTION_MODEL)
    payload.set("response_format", "json")
    payload.set("file", fileValue, resolveUploadFileName(fileValue))

    const timeoutController = new AbortController()
    const timeout = setTimeout(() => timeoutController.abort(), OPENAI_TRANSCRIPTION_TIMEOUT_MS)

    try {
      const upstreamResponse = await fetch(OPENAI_TRANSCRIPTION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: payload,
        signal: timeoutController.signal,
      })

      if (!upstreamResponse.ok) {
        const statusCode = upstreamResponse.status === 401 || upstreamResponse.status === 403 ? 401 : 502

        return c.json(
          {
            error:
              statusCode === 401
                ? "OpenAI API key rejected — update it in Settings."
                : "Transcription failed. Please try again.",
          },
          statusCode,
        )
      }

      const result = (await upstreamResponse.json()) as { text?: unknown }
      if (typeof result.text !== "string") {
        return c.json({ error: "Invalid transcription response." }, 502)
      }

      return c.json({ text: result.text })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return c.json({ error: "Transcription timed out." }, 504)
      }

      throw error
    } finally {
      clearTimeout(timeout)
    }
  })

  return app
}

function resolveOpenAiApiKey(swarmManager: SwarmManager): string | undefined {
  const authStorage = AuthStorage.create(swarmManager.getConfig().paths.authFile)
  const credential = authStorage.get("openai-codex")
  return extractAuthCredentialToken(credential as AuthCredential | undefined)
}

function extractAuthCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object") {
    return undefined
  }

  if (credential.type === "api_key") {
    const apiKey = normalizeAuthToken((credential as { key?: unknown }).key)
    if (apiKey) {
      return apiKey
    }
  }

  const accessToken = normalizeAuthToken((credential as { access?: unknown }).access)
  if (accessToken) {
    return accessToken
  }

  return undefined
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

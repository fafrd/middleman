import { Hono } from "hono"
import type { IntegrationRegistryService } from "../../integrations/registry.js"
import type { SwarmManager } from "../../swarm/swarm-manager.js"
import {
  DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
  createBodyLimit,
  createCorsMiddleware,
  createMethodGuard,
  readJsonBody,
  type NodeServerEnv,
} from "../hono-utils.js"

const SLACK_CONFIG_ENDPOINT_PATH = "/api/managers/:managerId/integrations/slack"
const SLACK_TEST_ENDPOINT_PATH = "/api/managers/:managerId/integrations/slack/test"
const SLACK_CHANNELS_ENDPOINT_PATH = "/api/managers/:managerId/integrations/slack/channels"
const TELEGRAM_CONFIG_ENDPOINT_PATH = "/api/managers/:managerId/integrations/telegram"
const TELEGRAM_TEST_ENDPOINT_PATH = "/api/managers/:managerId/integrations/telegram/test"
const CONFIG_METHODS = ["GET", "PUT", "DELETE"] as const
const TEST_METHODS = ["POST"] as const
const CHANNEL_METHODS = ["GET"] as const

export function createIntegrationRoutes(options: {
  swarmManager: SwarmManager
  integrationRegistry: IntegrationRegistryService | null
}): Hono<NodeServerEnv> {
  const { swarmManager, integrationRegistry } = options
  const app = new Hono<NodeServerEnv>()

  app.use(SLACK_CONFIG_ENDPOINT_PATH, createCorsMiddleware(CONFIG_METHODS))
  app.use(SLACK_CONFIG_ENDPOINT_PATH, createMethodGuard(CONFIG_METHODS))
  app.get(SLACK_CONFIG_ENDPOINT_PATH, async (c) => {
    const managerId = c.req.param("managerId")
    const registryResponse = requireIntegrationRegistry(
      swarmManager,
      integrationRegistry,
      managerId,
      "Slack",
    )
    if (registryResponse) {
      return registryResponse
    }

    const registry = integrationRegistry as IntegrationRegistryService
    const snapshot = await registry.getSlackSnapshot(managerId)
    return c.json(snapshot)
  })
  app.put(
    SLACK_CONFIG_ENDPOINT_PATH,
    createBodyLimit(
      DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
      `Request body too large. Max ${DEFAULT_MAX_HTTP_BODY_SIZE_BYTES} bytes.`,
      400,
    ),
    async (c) => {
      const managerId = c.req.param("managerId")
      const registryResponse = requireIntegrationRegistry(
        swarmManager,
        integrationRegistry,
        managerId,
        "Slack",
      )
      if (registryResponse) {
        return registryResponse
      }

      const registry = integrationRegistry as IntegrationRegistryService
      const payload = await readJsonBody(c, {
        emptyValue: {},
        invalidJsonMessage: "Request body must be valid JSON",
      })
      const updated = await registry.updateSlackConfig(managerId, payload)
      return c.json({ ok: true, ...updated })
    },
  )
  app.delete(SLACK_CONFIG_ENDPOINT_PATH, async (c) => {
    const managerId = c.req.param("managerId")
    const registryResponse = requireIntegrationRegistry(
      swarmManager,
      integrationRegistry,
      managerId,
      "Slack",
    )
    if (registryResponse) {
      return registryResponse
    }

    const registry = integrationRegistry as IntegrationRegistryService
    const disabled = await registry.disableSlack(managerId)
    return c.json({ ok: true, ...disabled })
  })

  app.use(SLACK_TEST_ENDPOINT_PATH, createCorsMiddleware(TEST_METHODS))
  app.use(SLACK_TEST_ENDPOINT_PATH, createMethodGuard(TEST_METHODS))
  app.post(
    SLACK_TEST_ENDPOINT_PATH,
    createBodyLimit(
      DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
      `Request body too large. Max ${DEFAULT_MAX_HTTP_BODY_SIZE_BYTES} bytes.`,
      400,
    ),
    async (c) => {
      const managerId = c.req.param("managerId")
      const registryResponse = requireIntegrationRegistry(
        swarmManager,
        integrationRegistry,
        managerId,
        "Slack",
      )
      if (registryResponse) {
        return registryResponse
      }

      const registry = integrationRegistry as IntegrationRegistryService
      const payload = await readJsonBody(c, {
        emptyValue: {},
        invalidJsonMessage: "Request body must be valid JSON",
      })
      const result = await registry.testSlackConnection(managerId, payload)
      return c.json({ ok: true, result })
    },
  )

  app.use(SLACK_CHANNELS_ENDPOINT_PATH, createCorsMiddleware(CHANNEL_METHODS))
  app.use(SLACK_CHANNELS_ENDPOINT_PATH, createMethodGuard(CHANNEL_METHODS))
  app.get(SLACK_CHANNELS_ENDPOINT_PATH, async (c) => {
    const managerId = c.req.param("managerId")
    const registryResponse = requireIntegrationRegistry(
      swarmManager,
      integrationRegistry,
      managerId,
      "Slack",
    )
    if (registryResponse) {
      return registryResponse
    }

    const registry = integrationRegistry as IntegrationRegistryService
    const includePrivate = parseOptionalBoolean(c.req.query("includePrivateChannels") ?? null)
    const channels = await registry.listSlackChannels(managerId, {
      includePrivateChannels: includePrivate,
    })

    return c.json({ channels })
  })

  app.use(TELEGRAM_CONFIG_ENDPOINT_PATH, createCorsMiddleware(CONFIG_METHODS))
  app.use(TELEGRAM_CONFIG_ENDPOINT_PATH, createMethodGuard(CONFIG_METHODS))
  app.get(TELEGRAM_CONFIG_ENDPOINT_PATH, async (c) => {
    const managerId = c.req.param("managerId")
    const registryResponse = requireIntegrationRegistry(
      swarmManager,
      integrationRegistry,
      managerId,
      "Telegram",
    )
    if (registryResponse) {
      return registryResponse
    }

    const registry = integrationRegistry as IntegrationRegistryService
    const snapshot = await registry.getTelegramSnapshot(managerId)
    return c.json(snapshot)
  })
  app.put(
    TELEGRAM_CONFIG_ENDPOINT_PATH,
    createBodyLimit(
      DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
      `Request body too large. Max ${DEFAULT_MAX_HTTP_BODY_SIZE_BYTES} bytes.`,
      400,
    ),
    async (c) => {
      const managerId = c.req.param("managerId")
      const registryResponse = requireIntegrationRegistry(
        swarmManager,
        integrationRegistry,
        managerId,
        "Telegram",
      )
      if (registryResponse) {
        return registryResponse
      }

      const registry = integrationRegistry as IntegrationRegistryService
      const payload = await readJsonBody(c, {
        emptyValue: {},
        invalidJsonMessage: "Request body must be valid JSON",
      })
      const updated = await registry.updateTelegramConfig(managerId, payload)
      return c.json({ ok: true, ...updated })
    },
  )
  app.delete(TELEGRAM_CONFIG_ENDPOINT_PATH, async (c) => {
    const managerId = c.req.param("managerId")
    const registryResponse = requireIntegrationRegistry(
      swarmManager,
      integrationRegistry,
      managerId,
      "Telegram",
    )
    if (registryResponse) {
      return registryResponse
    }

    const registry = integrationRegistry as IntegrationRegistryService
    const disabled = await registry.disableTelegram(managerId)
    return c.json({ ok: true, ...disabled })
  })

  app.use(TELEGRAM_TEST_ENDPOINT_PATH, createCorsMiddleware(TEST_METHODS))
  app.use(TELEGRAM_TEST_ENDPOINT_PATH, createMethodGuard(TEST_METHODS))
  app.post(
    TELEGRAM_TEST_ENDPOINT_PATH,
    createBodyLimit(
      DEFAULT_MAX_HTTP_BODY_SIZE_BYTES,
      `Request body too large. Max ${DEFAULT_MAX_HTTP_BODY_SIZE_BYTES} bytes.`,
      400,
    ),
    async (c) => {
      const managerId = c.req.param("managerId")
      const registryResponse = requireIntegrationRegistry(
        swarmManager,
        integrationRegistry,
        managerId,
        "Telegram",
      )
      if (registryResponse) {
        return registryResponse
      }

      const registry = integrationRegistry as IntegrationRegistryService
      const payload = await readJsonBody(c, {
        emptyValue: {},
        invalidJsonMessage: "Request body must be valid JSON",
      })
      const result = await registry.testTelegramConnection(managerId, payload)
      return c.json({ ok: true, result })
    },
  )

  return app
}

function requireIntegrationRegistry(
  swarmManager: SwarmManager,
  integrationRegistry: IntegrationRegistryService | null,
  managerId: string,
  providerName: "Slack" | "Telegram",
): Response | null {
  if (!integrationRegistry) {
    return Response.json({ error: `${providerName} integration is unavailable` }, { status: 501 })
  }

  if (!isManagerAgent(swarmManager, managerId)) {
    return Response.json({ error: `Unknown manager: ${managerId}` }, { status: 404 })
  }

  return null
}

function isManagerAgent(swarmManager: SwarmManager, managerId: string): boolean {
  const descriptor = swarmManager.getAgent(managerId)
  return Boolean(descriptor && descriptor.role === "manager")
}

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false
  }

  return undefined
}

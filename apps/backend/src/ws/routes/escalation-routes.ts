import type { ClientCommand, ServerEvent } from "@middleman/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const ESCALATIONS_ENDPOINT_PATH = "/api/escalations";
const ESCALATION_ENDPOINT_PATTERN = /^\/api\/escalations\/([^/]+)$/;

export function createEscalationHttpRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  return [
    {
      methods: "GET, POST, OPTIONS",
      matches: (pathname) => pathname === ESCALATIONS_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleEscalationsCollectionHttpRequest(options.swarmManager, request, response, requestUrl);
      }
    },
    {
      methods: "GET, PATCH, OPTIONS",
      matches: (pathname) => ESCALATION_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleEscalationItemHttpRequest(options.swarmManager, request, response, requestUrl);
      }
    }
  ];
}

export interface EscalationCommandRouteContext {
  command: ClientCommand;
  socket: WebSocket;
  swarmManager: SwarmManager;
  send: (socket: WebSocket, event: ServerEvent) => void;
}

export async function handleEscalationCommand(context: EscalationCommandRouteContext): Promise<boolean> {
  const { command, socket, swarmManager, send } = context;

  if (command.type === "get_all_escalations") {
    try {
      send(socket, {
        type: "escalations_snapshot",
        escalations: swarmManager.listAllEscalations(),
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "GET_ALL_ESCALATIONS_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  if (command.type === "resolve_escalation") {
    try {
      const escalation = await swarmManager.resolveEscalation(command.escalationId, {
        choice: command.choice,
        isCustom: command.isCustom,
        sourceContext: { channel: "web" }
      });

      send(socket, {
        type: "escalation_resolution_result",
        escalation,
        requestId: command.requestId
      });
    } catch (error) {
      send(socket, {
        type: "error",
        code: "RESOLVE_ESCALATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        requestId: command.requestId
      });
    }

    return true;
  }

  return false;
}

async function handleEscalationsCollectionHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "GET, POST, OPTIONS";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "GET") {
    applyCorsHeaders(request, response, methods);

    try {
      const { managerId, status } = parseListEscalationsRequest(requestUrl);
      const escalations = await swarmManager.listEscalationsForManager(managerId, status);
      sendJson(response, 200, { escalations });
    } catch (error) {
      sendEscalationHttpError(request, response, methods, error);
    }
    return;
  }

  if (request.method === "POST") {
    applyCorsHeaders(request, response, methods);

    try {
      const payload = parseCreateEscalationBody(await readJsonBody(request));
      const escalation = await swarmManager.createEscalationForManager(payload.managerId, {
        title: payload.title,
        description: payload.description,
        options: payload.options
      });
      sendJson(response, 201, { escalation });
    } catch (error) {
      sendEscalationHttpError(request, response, methods, error);
    }
    return;
  }

  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleEscalationItemHttpRequest(
  swarmManager: SwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  const methods = "GET, PATCH, OPTIONS";
  const matched = requestUrl.pathname.match(ESCALATION_ENDPOINT_PATTERN);
  const rawEscalationId = matched?.[1] ?? "";

  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, methods);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, methods);

  const escalationId = decodeURIComponent(rawEscalationId).trim();
  if (!escalationId) {
    sendJson(response, 400, { error: "Missing escalation id" });
    return;
  }

  try {
    if (request.method === "GET") {
      const { managerId } = parseGetEscalationRequest(requestUrl);
      const escalation = swarmManager.getEscalationForManager(managerId, escalationId);
      sendJson(response, 200, { escalation });
      return;
    }

    if (request.method === "PATCH") {
      const payload = parsePatchEscalationBody(await readJsonBody(request));
      const escalation = await swarmManager.closeEscalationForManager(payload.managerId, escalationId, {
        comment: payload.comment
      });
      sendJson(response, 200, { escalation });
      return;
    }

    response.setHeader("Allow", methods);
    sendJson(response, 405, { error: "Method Not Allowed" });
  } catch (error) {
    sendEscalationHttpError(request, response, methods, error);
  }
}

function parseRequiredManagerId(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("managerId is required");
  }

  return value.trim();
}

function parseListEscalationsRequest(requestUrl: URL): {
  managerId: string;
  status: "open" | "resolved" | "all";
} {
  const managerId = parseRequiredManagerId(requestUrl.searchParams.get("managerId"));
  const rawStatus = requestUrl.searchParams.get("status")?.trim();
  const status = rawStatus ?? "open";

  if (status !== "open" && status !== "resolved" && status !== "all") {
    throw new Error('status must be "open", "resolved", or "all" when provided');
  }

  return {
    managerId,
    status
  };
}

function parseCreateEscalationBody(value: unknown): {
  managerId: string;
  title: string;
  description: string;
  options: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybe = value as {
    managerId?: unknown;
    title?: unknown;
    description?: unknown;
    options?: unknown;
  };

  if (typeof maybe.title !== "string" || maybe.title.trim().length === 0) {
    throw new Error("title is required");
  }
  if (typeof maybe.description !== "string" || maybe.description.trim().length === 0) {
    throw new Error("description is required");
  }
  if (!Array.isArray(maybe.options)) {
    throw new Error("options must be an array");
  }

  return {
    managerId: parseRequiredManagerId(typeof maybe.managerId === "string" ? maybe.managerId : undefined),
    title: maybe.title.trim(),
    description: maybe.description.trim(),
    options: maybe.options.map((option) => {
      if (typeof option !== "string") {
        throw new Error("options must contain only strings");
      }

      const normalizedOption = option.trim();
      if (normalizedOption.length === 0) {
        throw new Error("options must not contain blank values");
      }

      return normalizedOption;
    })
  };
}

function parseGetEscalationRequest(requestUrl: URL): { managerId: string } {
  return {
    managerId: parseRequiredManagerId(requestUrl.searchParams.get("managerId"))
  };
}

function parsePatchEscalationBody(value: unknown): {
  managerId: string;
  status: "resolved";
  comment?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybe = value as {
    managerId?: unknown;
    status?: unknown;
    comment?: unknown;
  };

  if (maybe.status !== "resolved") {
    throw new Error('status must be "resolved"');
  }
  if (maybe.comment !== undefined && typeof maybe.comment !== "string") {
    throw new Error("comment must be a string when provided");
  }

  return {
    managerId: parseRequiredManagerId(typeof maybe.managerId === "string" ? maybe.managerId : undefined),
    status: "resolved",
    comment: typeof maybe.comment === "string" && maybe.comment.trim().length > 0 ? maybe.comment.trim() : undefined
  };
}

function sendEscalationHttpError(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
  error: unknown
): void {
  applyCorsHeaders(request, response, methods);
  const message = error instanceof Error ? error.message : String(error);
  const statusCode =
    message.includes("Unknown manager") || message.includes("Unknown escalation")
      ? 404
      : message.includes("does not belong to manager")
        ? 403
        : message.includes("required") || message.includes("must be") || message.includes("Only manager")
          ? 400
          : 500;

  sendJson(response, statusCode, { error: message });
}

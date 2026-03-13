import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ServerEvent } from "@middleman/protocol";
import { getConversationHistoryCacheFilePath } from "./conversation-history-cache.js";
import { isConversationEntryEvent } from "./conversation-validators.js";
import {
  extractMessageErrorMessage,
  extractMessageImageAttachments,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
  isStrictContextOverflowMessage,
  normalizeProviderErrorMessage
} from "./message-utils.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "./runtime-types.js";
import type {
  AgentDescriptor,
  AgentMessageEvent,
  AgentToolCallEvent,
  ConversationEscalationEvent,
  ConversationEntryEvent,
  ConversationLogEvent,
  ConversationMessageEvent
} from "./types.js";

const MAX_CONVERSATION_HISTORY = 2000;
const MAX_SAFE_JSON_BYTES = 10 * 1024;
const SAFE_JSON_TRUNCATED_SUFFIX = " [truncated]";
const CONVERSATION_ENTRY_TYPE = "swarm_conversation_entry";
const MANAGER_ERROR_CONTEXT_HINT = "Try compacting the conversation to free up context space.";
const MANAGER_ERROR_GENERIC_HINT = "Please retry. If this persists, check provider auth and rate limits.";

type ConversationEventName =
  | "conversation_message"
  | "conversation_escalation"
  | "conversation_log"
  | "agent_message"
  | "agent_tool_call"
  | "conversation_reset";

interface ConversationProjectorDependencies {
  descriptors: Map<string, AgentDescriptor>;
  runtimes: Map<string, SwarmAgentRuntime>;
  conversationEntriesByAgentId: Map<string, ConversationEntryEvent[]>;
  now: () => string;
  emitServerEvent: (eventName: ConversationEventName, payload: ServerEvent) => void;
  logDebug: (message: string, details?: unknown) => void;
}

export class ConversationProjector {
  private readonly pendingCacheWrites = new Map<string, Promise<void>>();
  private readonly queuedCacheSnapshots = new Map<string, ConversationEntryEvent[] | null>();

  constructor(private readonly deps: ConversationProjectorDependencies) {}

  getConversationHistory(agentId: string, limit?: number): ConversationEntryEvent[] {
    const history = this.getOrLoadConversationHistory(agentId);
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
    const startIndex = normalizedLimit ? findVisibleHistoryStartIndex(history, normalizedLimit) : 0;
    return history.slice(startIndex);
  }

  getVisibleTranscript(
    agentId: string,
    limit?: number
  ): Array<ConversationMessageEvent | ConversationEscalationEvent> {
    const history = this.getOrLoadConversationHistory(agentId);
    const visibleEntries = history.filter(isVisibleConversationEntry);
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
    const startIndex = normalizedLimit ? Math.max(0, visibleEntries.length - normalizedLimit) : 0;
    return visibleEntries.slice(startIndex);
  }

  resetConversationHistory(agentId: string): void {
    this.deps.conversationEntriesByAgentId.set(agentId, []);
    const descriptor = this.deps.descriptors.get(agentId);
    if (descriptor) {
      this.queueCacheSnapshotWrite(descriptor.sessionFile, null);
    }
  }

  deleteConversationHistory(agentId: string): void {
    this.deps.conversationEntriesByAgentId.delete(agentId);
    const descriptor = this.deps.descriptors.get(agentId);
    if (descriptor) {
      this.queueCacheSnapshotWrite(descriptor.sessionFile, null);
    }
  }

  emitConversationMessage(event: ConversationMessageEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("conversation_message", event satisfies ServerEvent);
  }

  emitConversationEscalation(event: ConversationEscalationEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("conversation_escalation", event satisfies ServerEvent);
  }

  emitConversationLog(event: ConversationLogEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("conversation_log", event satisfies ServerEvent);
  }

  emitAgentMessage(event: AgentMessageEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("agent_message", event satisfies ServerEvent);
  }

  emitAgentToolCall(event: AgentToolCallEvent): void {
    this.emitConversationEntry(event);
    this.deps.emitServerEvent("agent_tool_call", event satisfies ServerEvent);
  }

  emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.deps.emitServerEvent(
      "conversation_reset",
      {
        type: "conversation_reset",
        agentId,
        timestamp: this.deps.now(),
        reason
      } satisfies ServerEvent
    );
  }

  loadConversationHistoriesFromStore(): void {
    this.deps.conversationEntriesByAgentId.clear();

    for (const descriptor of this.deps.descriptors.values()) {
      if (!this.shouldPreloadHistoryForDescriptor(descriptor)) {
        continue;
      }
      this.loadConversationHistoryForDescriptor(descriptor);
    }
  }

  captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void {
    const descriptor = this.deps.descriptors.get(agentId);
    const timestamp = this.deps.now();
    if (descriptor) {
      const managerContextId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
      this.captureToolCallActivityFromRuntime(managerContextId, agentId, event, timestamp);
    }

    if (descriptor?.role === "manager") {
      this.captureManagerRuntimeErrorConversationEvent(agentId, event);
      return;
    }

    switch (event.type) {
      case "message_start": {
        const role = extractRole(event.message);
        if (role !== "user" && role !== "assistant" && role !== "system") {
          return;
        }

        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_start",
          role,
          text: extractMessageText(event.message) ?? "(non-text message)"
        });
        return;
      }

      case "message_end": {
        const role = extractRole(event.message);
        if (role !== "user" && role !== "assistant" && role !== "system") {
          return;
        }

        const extractedText = extractMessageText(event.message);
        const text = extractedText ?? "(non-text message)";
        const attachments = extractMessageImageAttachments(event.message);

        if ((role === "assistant" || role === "system") && (extractedText || attachments.length > 0)) {
          this.emitConversationMessage({
            type: "conversation_message",
            agentId,
            role,
            text: extractedText ?? "",
            attachments: attachments.length > 0 ? attachments : undefined,
            timestamp,
            source: "system"
          });
        }

        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_end",
          role,
          text
        });
        return;
      }

      case "tool_execution_start":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.args)
        });
        return;

      case "tool_execution_update":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_update",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.partialResult)
        });
        return;

      case "tool_execution_end":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.result),
          isError: event.isError
        });
        return;

      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private emitConversationEntry(event: ConversationEntryEvent): void {
    const history = this.getOrLoadConversationHistory(event.agentId);
    history.push(event);
    trimConversationHistory(history);
    this.deps.conversationEntriesByAgentId.set(event.agentId, history);
    this.queueConversationHistoryCacheWrite(event.agentId, history);

    if (!shouldPersistConversationEntryToSession(event)) {
      return;
    }

    const runtime = this.deps.runtimes.get(event.agentId);
    try {
      if (runtime) {
        runtime.appendCustomEntry(CONVERSATION_ENTRY_TYPE, event);
        return;
      }

      const descriptor = this.deps.descriptors.get(event.agentId);
      if (!descriptor) {
        return;
      }

      SessionManager.open(descriptor.sessionFile).appendCustomEntry(CONVERSATION_ENTRY_TYPE, event);
    } catch (error) {
      this.deps.logDebug("history:save:error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private shouldPreloadHistoryForDescriptor(descriptor: AgentDescriptor): boolean {
    return descriptor.role === "manager" || descriptor.status === "streaming";
  }

  private getOrLoadConversationHistory(agentId: string): ConversationEntryEvent[] {
    const existing = this.deps.conversationEntriesByAgentId.get(agentId);
    if (existing) {
      return existing;
    }

    const descriptor = this.deps.descriptors.get(agentId);
    if (!descriptor) {
      return [];
    }

    return this.loadConversationHistoryForDescriptor(descriptor);
  }

  private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): ConversationEntryEvent[] {
    const cachedEntries = this.loadConversationHistoryFromCache(descriptor.sessionFile);
    if (cachedEntries) {
      trimConversationHistory(cachedEntries);
      this.deps.conversationEntriesByAgentId.set(descriptor.agentId, cachedEntries);
      this.deps.logDebug("history:load:cache", {
        agentId: descriptor.agentId,
        messageCount: cachedEntries.length
      });
      return cachedEntries;
    }

    const entriesForAgent: ConversationEntryEvent[] = [];

    try {
      const sessionManager = SessionManager.open(descriptor.sessionFile);
      const entries = sessionManager.getEntries();

      for (const entry of entries) {
        if (entry.type !== "custom") {
          continue;
        }

        if (entry.customType !== CONVERSATION_ENTRY_TYPE) {
          continue;
        }
        if (!isConversationEntryEvent(entry.data)) {
          continue;
        }
        entriesForAgent.push(entry.data);
      }

      trimConversationHistory(entriesForAgent);

      this.deps.logDebug("history:load:ready", {
        agentId: descriptor.agentId,
        messageCount: entriesForAgent.length
      });
    } catch (error) {
      this.deps.logDebug("history:load:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    this.deps.conversationEntriesByAgentId.set(descriptor.agentId, entriesForAgent);
    this.queueConversationHistoryCacheWrite(descriptor.agentId, entriesForAgent);
    return entriesForAgent;
  }

  private loadConversationHistoryFromCache(sessionFile: string): ConversationEntryEvent[] | null {
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    if (!existsSync(cacheFile)) {
      return null;
    }

    try {
      const raw = readFileSync(cacheFile, "utf8");
      if (raw.trim().length === 0) {
        return [];
      }

      const entries: ConversationEntryEvent[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (isConversationEntryEvent(parsed)) {
          entries.push(parsed);
        }
      }

      if (entries.length === 0 && raw.trim().length > 0) {
        return null;
      }

      return entries;
    } catch (error) {
      this.deps.logDebug("history:load:cache:error", {
        cacheFile,
        message: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private queueConversationHistoryCacheWrite(agentId: string, history: ConversationEntryEvent[]): void {
    const descriptor = this.deps.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    this.queueCacheSnapshotWrite(descriptor.sessionFile, history.slice());
  }

  private queueCacheSnapshotWrite(sessionFile: string, history: ConversationEntryEvent[] | null): void {
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    this.queuedCacheSnapshots.set(cacheFile, history);

    if (this.pendingCacheWrites.has(cacheFile)) {
      return;
    }

    const writePromise = this.flushQueuedCacheSnapshot(cacheFile)
      .catch((error) => {
        this.deps.logDebug("history:cache:write:error", {
          cacheFile,
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.pendingCacheWrites.delete(cacheFile);
        if (this.queuedCacheSnapshots.has(cacheFile)) {
          this.queueCacheSnapshotWrite(sessionFile, this.queuedCacheSnapshots.get(cacheFile) ?? null);
        }
      });

    this.pendingCacheWrites.set(cacheFile, writePromise);
  }

  private async flushQueuedCacheSnapshot(cacheFile: string): Promise<void> {
    while (this.queuedCacheSnapshots.has(cacheFile)) {
      const history = this.queuedCacheSnapshots.get(cacheFile) ?? null;
      this.queuedCacheSnapshots.delete(cacheFile);

      if (history === null) {
        await rm(cacheFile, { force: true });
        continue;
      }

      await mkdir(dirname(cacheFile), { recursive: true });
      const serializedHistory =
        history.length === 0 ? "" : `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
      await writeFile(cacheFile, serializedHistory, "utf8");
    }
  }

  private captureManagerRuntimeErrorConversationEvent(agentId: string, event: RuntimeSessionEvent): void {
    if (event.type !== "message_end") {
      return;
    }

    const role = extractRole(event.message);
    if (role !== "assistant") {
      return;
    }

    const stopReason = extractMessageStopReason(event.message);
    const hasStructuredErrorMessage = hasMessageErrorMessageField(event.message);
    if (stopReason !== "error" && !hasStructuredErrorMessage) {
      return;
    }

    const messageText = extractMessageText(event.message);
    const normalizedErrorMessage = normalizeProviderErrorMessage(extractMessageErrorMessage(event.message) ?? messageText);
    const isContextOverflow = isStrictContextOverflowMessage(normalizedErrorMessage);

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: buildManagerErrorConversationText({
        errorMessage: normalizedErrorMessage,
        isContextOverflow
      }),
      timestamp: this.deps.now(),
      source: "system"
    });
  }

  private captureToolCallActivityFromRuntime(
    managerContextId: string,
    actorAgentId: string,
    event: RuntimeSessionEvent,
    timestamp: string
  ): void {
    switch (event.type) {
      case "tool_execution_start":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.args)
        });
        return;

      case "tool_execution_update":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_update",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.partialResult)
        });
        return;

      case "tool_execution_end":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.result),
          isError: event.isError
        });
        return;

      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "message_end":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }
}

function safeJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }

  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes <= MAX_SAFE_JSON_BYTES) {
    return serialized;
  }

  const suffixBytes = Buffer.byteLength(SAFE_JSON_TRUNCATED_SUFFIX, "utf8");
  if (MAX_SAFE_JSON_BYTES <= suffixBytes) {
    return SAFE_JSON_TRUNCATED_SUFFIX;
  }

  const previewByteCount = MAX_SAFE_JSON_BYTES - suffixBytes;
  const preview = Buffer.from(serialized, "utf8").subarray(0, previewByteCount).toString("utf8");
  return `${preview}${SAFE_JSON_TRUNCATED_SUFFIX}`;
}

function buildManagerErrorConversationText(options: {
  errorMessage?: string;
  isContextOverflow: boolean;
}): string {
  if (options.isContextOverflow) {
    if (options.errorMessage) {
      return `⚠️ Manager reply failed because the prompt exceeded the model context window (${options.errorMessage}). ${MANAGER_ERROR_CONTEXT_HINT}`;
    }

    return `⚠️ Manager reply failed because the prompt exceeded the model context window. ${MANAGER_ERROR_CONTEXT_HINT}`;
  }

  if (options.errorMessage) {
    return `⚠️ Manager reply failed: ${options.errorMessage}. ${MANAGER_ERROR_GENERIC_HINT}`;
  }

  return `⚠️ Manager reply failed. ${MANAGER_ERROR_GENERIC_HINT}`;
}

function isVisibleConversationEntry(
  entry: ConversationEntryEvent
): entry is ConversationMessageEvent | ConversationEscalationEvent {
  if (entry.type === "conversation_escalation") {
    return true;
  }

  return entry.type === "conversation_message" && (entry.source === "user_input" || entry.source === "speak_to_user");
}

function shouldPersistConversationEntryToSession(entry: ConversationEntryEvent): boolean {
  return isVisibleConversationEntry(entry);
}

function findVisibleHistoryStartIndex(entries: ConversationEntryEvent[], visibleLimit: number): number {
  let seenVisibleEntries = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!isVisibleConversationEntry(entries[index])) {
      continue;
    }

    seenVisibleEntries += 1;
    if (seenVisibleEntries >= visibleLimit) {
      return index;
    }
  }

  return 0;
}

function isPreservedWebTranscriptEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "conversation_escalation") {
    return true;
  }

  if (entry.type !== "conversation_message") {
    return false;
  }

  if (entry.source !== "user_input" && entry.source !== "speak_to_user") {
    return false;
  }

  return (entry.sourceContext?.channel ?? "web") === "web";
}

function trimConversationHistory(entries: ConversationEntryEvent[]): void {
  const overflow = entries.length - MAX_CONVERSATION_HISTORY;
  if (overflow <= 0) {
    return;
  }

  const removableIndexes: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (removableIndexes.length >= overflow) {
      break;
    }

    if (!isPreservedWebTranscriptEntry(entries[index])) {
      removableIndexes.push(index);
    }
  }

  if (removableIndexes.length === 0) {
    return;
  }

  for (let index = removableIndexes.length - 1; index >= 0; index -= 1) {
    entries.splice(removableIndexes[index], 1);
  }
}

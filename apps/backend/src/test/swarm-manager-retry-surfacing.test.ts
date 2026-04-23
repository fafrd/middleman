import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "../config.js";
import { resolveModelDescriptorFromPreset } from "../swarm/model-presets.js";
import { SwarmManager } from "../swarm/swarm-manager.js";
import {
  MIDDLEMAN_STORE_MIGRATIONS,
  MiddlemanAgentRepo,
  MiddlemanManagerOrderRepo,
  MiddlemanScheduleRepo,
  MiddlemanSettingsRepo,
} from "../swarm/swarm-sql.js";
import {
  EventBus,
  MessageCapture,
  MessageRepo,
  MessageService,
  MessageStore,
  OperationRepo,
  OperationService,
  SessionRepo,
  SessionService,
  backendRawEvent,
  createDatabase,
  messageCompletedEvent,
  runMigrations,
  type SessionRecord,
  type SessionRuntimeConfig,
  type SwarmdCoreHandle,
  type WorkerCommand,
} from "swarmd";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CODEX_TRANSIENT_ERROR =
  'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. Please include request ID abc in your message.","param":null},"sequence_number":2}';

type TestPreset = "pi-codex" | "pi-opus" | "codex-app";

interface SupervisorMock {
  activeSessions: Set<string>;
  sentCommands: Array<{ sessionId: string; command: WorkerCommand }>;
  hasWorker(sessionId: string): boolean;
  sendCommand(sessionId: string, command: WorkerCommand): void;
  shutdownAll(): Promise<void>;
  spawnWorker(session: SessionRecord, config: SessionRuntimeConfig): Promise<unknown>;
  stopWorker(sessionId: string): Promise<void>;
  terminateWorker(sessionId: string): Promise<void>;
}

interface Harness {
  close(): Promise<void>;
  eventBus: EventBus;
  manager: SwarmManager;
  sessionService: SessionService;
  supervisor: SupervisorMock;
  addAgent(input: {
    agentId: string;
    managerId: string;
    role: "manager" | "worker";
    status: SessionRecord["status"];
    model: TestPreset;
  }): Promise<void>;
}

function createSupervisorMock(): SupervisorMock {
  const activeSessions = new Set<string>();
  const sentCommands: Array<{ sessionId: string; command: WorkerCommand }> = [];

  return {
    activeSessions,
    sentCommands,
    hasWorker(sessionId: string) {
      return activeSessions.has(sessionId);
    },
    sendCommand(sessionId: string, command: WorkerCommand) {
      sentCommands.push({ sessionId, command });
    },
    async shutdownAll() {
      activeSessions.clear();
    },
    async spawnWorker(session: SessionRecord, _config: SessionRuntimeConfig) {
      activeSessions.add(session.id);
      return { sessionId: session.id };
    },
    async stopWorker(sessionId: string) {
      activeSessions.delete(sessionId);
    },
    async terminateWorker(sessionId: string) {
      activeSessions.delete(sessionId);
    },
  };
}

function toSessionInput(
  preset: TestPreset,
  role: "manager" | "worker",
): Pick<SessionRecord, "backend" | "model"> & { backendConfig: Record<string, unknown> } {
  const descriptor = resolveModelDescriptorFromPreset(preset);
  switch (preset) {
    case "codex-app":
      return {
        backend: "codex",
        model: descriptor.modelId,
        backendConfig: {
          thinkingLevel: descriptor.thinkingLevel,
          middleman: { role },
          env: {},
        },
      };
    case "pi-codex":
    case "pi-opus":
      return {
        backend: "pi",
        model: `${descriptor.provider}/${descriptor.modelId}`,
        backendConfig: {
          thinkingLevel: descriptor.thinkingLevel,
          middleman: { role },
          env: {},
          modelProvider: descriptor.provider,
          modelId: descriptor.modelId,
        },
      };
  }
}

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(resolve(tmpdir(), "middleman-retry-"));
  const manager = new SwarmManager(
    createConfig({
      installDir: REPO_ROOT,
      projectRoot: REPO_ROOT,
      dataDir,
    }),
  );

  const db = createDatabase(":memory:");
  runMigrations(db, { migrations: MIDDLEMAN_STORE_MIGRATIONS });

  const agentRepo = new MiddlemanAgentRepo(db);
  const managerOrderRepo = new MiddlemanManagerOrderRepo(db);
  const scheduleRepo = new MiddlemanScheduleRepo(db);
  const settingsRepo = new MiddlemanSettingsRepo(db);
  const sessionRepo = new SessionRepo(db);
  const messageRepo = new MessageRepo(db);
  const operationRepo = new OperationRepo(db);
  const eventBus = new EventBus();
  const supervisor = createSupervisorMock();
  const messageStore = new MessageStore(sessionRepo, messageRepo);
  const messageCapture = new MessageCapture(eventBus, messageStore);
  const operationService = new OperationService(operationRepo, eventBus);
  const sessionService = new SessionService(
    sessionRepo,
    messageRepo,
    operationRepo,
    supervisor as never,
    eventBus,
    operationService,
  );
  const messageService = new MessageService(
    sessionRepo,
    supervisor as never,
    operationService,
    messageStore,
  );

  const core = {
    config: { dataDir, dbPath: ":memory:" },
    db,
    supervisor: supervisor as never,
    sessionService,
    messageService,
    messageStore,
    operationService,
    eventBus,
    recoveryManager: {
      async recover() {
        return { attempted: 0, recovered: 0, failed: 0, results: [] };
      },
    },
    archiveSession(sessionId: string) {
      sessionService.archiveSession(sessionId);
    },
    async shutdown() {
      await supervisor.shutdownAll();
      db.close();
    },
  } as unknown as SwarmdCoreHandle;

  Object.assign(manager as object, {
    core,
    agentRepo,
    managerOrderRepo,
    scheduleRepo,
    settingsRepo,
  });
  (manager as any).installCoreEventProjection();

  return {
    async close() {
      messageCapture.dispose();
      await rm(dataDir, { recursive: true, force: true });
      db.close();
    },
    eventBus,
    manager,
    sessionService,
    supervisor,
    async addAgent(input) {
      const sessionInput = toSessionInput(input.model, input.role);
      sessionService.create({
        id: input.agentId,
        backend: sessionInput.backend,
        cwd: REPO_ROOT,
        model: sessionInput.model,
        displayName: input.agentId,
        systemPrompt: `${input.role} prompt`,
        backendConfig: sessionInput.backendConfig,
      });
      agentRepo.create({
        sessionId: input.agentId,
        role: input.role,
        managerSessionId: input.managerId,
        archetypeId: input.role === "manager" ? "manager" : undefined,
        memoryOwnerSessionId: input.managerId,
      });

      if (input.role === "manager") {
        managerOrderRepo.ensure([input.agentId]);
      }

      if (
        input.status === "starting" ||
        input.status === "idle" ||
        input.status === "busy" ||
        input.status === "interrupting" ||
        input.status === "stopping"
      ) {
        supervisor.activeSessions.add(input.agentId);
      }

      if (input.status !== "created") {
        sessionService.applyRuntimeStatus(input.agentId, input.status);
      }
    },
  };
}

function publishAssistantErrorCompletion(
  harness: Harness,
  agentId: string,
  errorMessage: string,
): void {
  harness.eventBus.publish({
    ...messageCompletedEvent({
      sessionId: agentId,
      threadId: null,
      source: "backend",
      messageId: `msg-error-${Math.random()}`,
      payload: {
        role: "assistant",
        stopReason: "error",
        errorMessage,
      },
    }),
    cursor: null,
  });
}

function publishAssistantSuccessCompletion(harness: Harness, agentId: string, text: string): void {
  harness.eventBus.publish({
    ...messageCompletedEvent({
      sessionId: agentId,
      threadId: null,
      source: "backend",
      messageId: `msg-ok-${Math.random()}`,
      payload: {
        role: "assistant",
        text,
      },
    }),
    cursor: null,
  });
}

function publishAutoRetryStart(
  harness: Harness,
  agentId: string,
  input: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string },
): void {
  harness.eventBus.publish({
    ...backendRawEvent({
      sessionId: agentId,
      threadId: null,
      payload: {
        type: "auto_retry_start",
        ...input,
      },
    }),
    cursor: null,
  });
}

function publishAutoRetryEnd(
  harness: Harness,
  agentId: string,
  input: { success: boolean; attempt: number; finalError?: string },
): void {
  harness.eventBus.publish({
    ...backendRawEvent({
      sessionId: agentId,
      threadId: null,
      payload: {
        type: "auto_retry_end",
        ...input,
      },
    }),
    cursor: null,
  });
}

function managerReportTexts(manager: SwarmManager, managerId: string): string[] {
  return manager
    .getVisibleTranscript(managerId)
    .flatMap((entry) =>
      entry.type === "agent_message" && entry.toAgentId === managerId ? [entry.text] : [],
    );
}

function workerConversationLogs(
  manager: SwarmManager,
  agentId: string,
): Array<{ text: string; isError: boolean | undefined }> {
  return manager
    .getConversationHistory(agentId)
    .filter((entry) => entry.type === "conversation_log")
    .map((entry) => ({ text: entry.text, isError: entry.isError }));
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

describe("SwarmManager Pi retry surfacing", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      await harnesses.pop()?.close();
    }
  });

  it("suppresses generic worker-error pings during transient retries and emits one exhausted summary after retries fail", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.addAgent({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "idle",
      model: "codex-app",
    });
    await harness.addAgent({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
      model: "pi-codex",
    });

    publishAssistantErrorCompletion(harness, "worker-1", CODEX_TRANSIENT_ERROR);
    await flushAsyncWork();

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([]);
    expect(workerConversationLogs(harness.manager, "worker-1")).toEqual([
      {
        text: CODEX_TRANSIENT_ERROR,
        isError: undefined,
      },
    ]);

    publishAutoRetryStart(harness, "worker-1", {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: CODEX_TRANSIENT_ERROR,
    });
    await flushAsyncWork();

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([]);

    publishAutoRetryEnd(harness, "worker-1", {
      success: false,
      attempt: 3,
      finalError: CODEX_TRANSIENT_ERROR,
    });

    await waitForCondition(() => managerReportTexts(harness.manager, "manager-1").length === 1);

    harness.sessionService.reportRuntimeError("worker-1", {
      code: "WORKER_ERROR",
      message: CODEX_TRANSIENT_ERROR,
      retryable: true,
    });
    await flushAsyncWork();

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      `SYSTEM: Worker worker-1 errored: Transient provider retries exhausted after 3 attempts: ${CODEX_TRANSIENT_ERROR}`,
    ]);
    expect(workerConversationLogs(harness.manager, "worker-1")).toEqual([
      {
        text: CODEX_TRANSIENT_ERROR,
        isError: undefined,
      },
      {
        text: `Pi auto-retrying transient provider error in 2s (attempt 1/3): ${CODEX_TRANSIENT_ERROR}`,
        isError: undefined,
      },
      {
        text: `Pi auto-retry exhausted after 3 attempts: ${CODEX_TRANSIENT_ERROR}`,
        isError: true,
      },
    ]);
  });

  it("keeps retry state isolated across concurrent workers", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const workerAError = `${CODEX_TRANSIENT_ERROR} [worker-a]`;
    const workerBError = "connect ECONNREFUSED 127.0.0.1:443 [worker-b]";

    await harness.addAgent({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "idle",
      model: "codex-app",
    });
    await harness.addAgent({
      agentId: "worker-a",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
      model: "pi-codex",
    });
    await harness.addAgent({
      agentId: "worker-b",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
      model: "pi-codex",
    });

    publishAssistantErrorCompletion(harness, "worker-a", workerAError);
    publishAssistantErrorCompletion(harness, "worker-b", workerBError);
    publishAutoRetryStart(harness, "worker-a", {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1_000,
      errorMessage: workerAError,
    });
    publishAutoRetryStart(harness, "worker-b", {
      attempt: 2,
      maxAttempts: 4,
      delayMs: 4_000,
      errorMessage: workerBError,
    });
    publishAssistantSuccessCompletion(harness, "worker-a", "Worker A recovered.");
    publishAutoRetryEnd(harness, "worker-a", {
      success: true,
      attempt: 1,
    });
    harness.sessionService.applyRuntimeStatus("worker-a", "idle");
    publishAutoRetryEnd(harness, "worker-b", {
      success: false,
      attempt: 2,
      finalError: workerBError,
    });
    harness.sessionService.reportRuntimeError("worker-b", {
      code: "WORKER_ERROR",
      message: workerBError,
      retryable: true,
    });

    await waitForCondition(() => managerReportTexts(harness.manager, "manager-1").length === 2);

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      "SYSTEM: Worker worker-a succeeded after 1 transient provider retry.",
      `SYSTEM: Worker worker-b errored: Transient provider retries exhausted after 2 attempts: ${workerBError}`,
    ]);
    expect(workerConversationLogs(harness.manager, "worker-a")).toEqual([
      {
        text: workerAError,
        isError: undefined,
      },
      {
        text: `Pi auto-retrying transient provider error in 1s (attempt 1/3): ${workerAError}`,
        isError: undefined,
      },
      {
        text: "Worker A recovered.",
        isError: undefined,
      },
      {
        text: "Pi auto-retry recovered after 1 transient provider retry.",
        isError: undefined,
      },
    ]);
    expect(workerConversationLogs(harness.manager, "worker-b")).toEqual([
      {
        text: workerBError,
        isError: undefined,
      },
      {
        text: `Pi auto-retrying transient provider error in 4s (attempt 2/4): ${workerBError}`,
        isError: undefined,
      },
      {
        text: `Pi auto-retry exhausted after 2 attempts: ${workerBError}`,
        isError: true,
      },
    ]);
  });

  it("does not activate retry surfacing for Pi-Anthropic workers", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.addAgent({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "idle",
      model: "codex-app",
    });
    await harness.addAgent({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
      model: "pi-opus",
    });

    publishAssistantErrorCompletion(harness, "worker-1", CODEX_TRANSIENT_ERROR);
    publishAutoRetryStart(harness, "worker-1", {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: CODEX_TRANSIENT_ERROR,
    });
    publishAutoRetryEnd(harness, "worker-1", {
      success: true,
      attempt: 1,
    });
    await flushAsyncWork();

    await waitForCondition(() => managerReportTexts(harness.manager, "manager-1").length === 1);

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      `SYSTEM: Worker worker-1 errored: ${CODEX_TRANSIENT_ERROR}`,
    ]);
    expect(workerConversationLogs(harness.manager, "worker-1")).toEqual([
      {
        text: CODEX_TRANSIENT_ERROR,
        isError: true,
      },
    ]);
  });

  it("emits a succeeded-after-retries summary and suppresses the generic completion ping", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    await harness.addAgent({
      agentId: "manager-1",
      managerId: "manager-1",
      role: "manager",
      status: "idle",
      model: "codex-app",
    });
    await harness.addAgent({
      agentId: "worker-1",
      managerId: "manager-1",
      role: "worker",
      status: "busy",
      model: "pi-codex",
    });

    publishAssistantErrorCompletion(harness, "worker-1", CODEX_TRANSIENT_ERROR);
    publishAutoRetryStart(harness, "worker-1", {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: CODEX_TRANSIENT_ERROR,
    });
    publishAssistantSuccessCompletion(harness, "worker-1", "Recovered and finished the task.");
    publishAutoRetryEnd(harness, "worker-1", {
      success: true,
      attempt: 1,
    });
    harness.sessionService.applyRuntimeStatus("worker-1", "idle");

    await waitForCondition(() => managerReportTexts(harness.manager, "manager-1").length === 1);

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      "SYSTEM: Worker worker-1 succeeded after 1 transient provider retry.",
    ]);
  });
});

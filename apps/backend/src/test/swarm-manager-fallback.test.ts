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
  createDatabase,
  messageCompletedEvent,
  runMigrations,
  type SessionRecord,
  type SessionRuntimeConfig,
  type SwarmdCoreHandle,
  type WorkerCommand,
} from "swarmd";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

type TestPreset = "pi-opus" | "pi-sonnet" | "pi-haiku" | "pi-codex" | "codex-app";

const PI_ANTHROPIC_FALLBACK_CASES = [
  ["pi-opus", "claude-code", "claude-opus-4-7", "xhigh"],
  ["pi-sonnet", "claude-code-sonnet", "claude-sonnet-4-6", "high"],
  ["pi-haiku", "claude-code-haiku", "claude-haiku-4-5", "medium"],
] as const;

interface SupervisorMock {
  activeSessions: Set<string>;
  sentCommands: Array<{ sessionId: string; command: WorkerCommand }>;
  spawnCalls: string[];
  stopCalls: string[];
  hasWorker(sessionId: string): boolean;
  sendCommand(sessionId: string, command: WorkerCommand): void;
  shutdownAll(): Promise<void>;
  spawnWorker(session: SessionRecord, config: SessionRuntimeConfig): Promise<unknown>;
  stopWorker(sessionId: string): Promise<void>;
  terminateWorker(sessionId: string): Promise<void>;
}

interface Harness {
  agentRepo: MiddlemanAgentRepo;
  close(): Promise<void>;
  core: SwarmdCoreHandle;
  eventBus: EventBus;
  manager: SwarmManager;
  messageCapture: MessageCapture;
  sessionService: SessionService;
  supervisor: SupervisorMock;
  addAgent(input: {
    agentId: string;
    managerId: string;
    role: "manager" | "worker";
    status: SessionRecord["status"];
    model: TestPreset;
    systemPrompt?: string;
    cwd?: string;
  }): Promise<void>;
}

function createSupervisorMock(): SupervisorMock {
  const activeSessions = new Set<string>();
  const sentCommands: Array<{ sessionId: string; command: WorkerCommand }> = [];
  const spawnCalls: string[] = [];
  const stopCalls: string[] = [];

  return {
    activeSessions,
    sentCommands,
    spawnCalls,
    stopCalls,
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
      spawnCalls.push(session.id);
      return { sessionId: session.id };
    },
    async stopWorker(sessionId: string) {
      activeSessions.delete(sessionId);
      stopCalls.push(sessionId);
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
    case "pi-opus":
    case "pi-sonnet":
    case "pi-haiku":
    case "pi-codex":
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
  const dataDir = await mkdtemp(resolve(tmpdir(), "middleman-fallback-"));
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
    agentRepo,
    async close() {
      messageCapture.dispose();
      await rm(dataDir, { recursive: true, force: true });
      db.close();
    },
    core,
    eventBus,
    manager,
    messageCapture,
    sessionService,
    supervisor,
    async addAgent(input) {
      const sessionInput = toSessionInput(input.model, input.role);
      sessionService.create({
        id: input.agentId,
        backend: sessionInput.backend,
        cwd: input.cwd ?? REPO_ROOT,
        model: sessionInput.model,
        displayName: input.agentId,
        systemPrompt: input.systemPrompt ?? `${input.role} prompt`,
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
      messageId: `msg-${Math.random()}`,
      payload: {
        role: "assistant",
        stopReason: "error",
        errorMessage,
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

function workerSendTexts(harness: Harness, agentId: string): string[] {
  return harness.supervisor.sentCommands
    .filter(
      (
        entry,
      ): entry is { sessionId: string; command: Extract<WorkerCommand, { type: "send_input" }> } =>
        entry.sessionId === agentId && entry.command.type === "send_input",
    )
    .map((entry) =>
      entry.command.input.parts
        .filter(
          (part): part is Extract<(typeof entry.command.input.parts)[number], { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join(""),
    );
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

describe("SwarmManager Pi-Anthropic fallback", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      await harnesses.pop()?.close();
    }
  });

  it.each(PI_ANTHROPIC_FALLBACK_CASES)(
    "respawns %s onto %s with the same agent identity and replays the pending instruction",
    async (sourcePreset, fallbackPreset, expectedModel, expectedThinkingLevel) => {
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
        model: sourcePreset,
        systemPrompt: "Original worker prompt",
        cwd: "/tmp/provider-error-handling",
      });

      await harness.manager.sendMessage(
        "manager-1",
        "worker-1",
        "Investigate the provider failure.",
      );

      publishAssistantErrorCompletion(
        harness,
        "worker-1",
        '400 invalid_request_error: "You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."',
      );

      await waitForCondition(() => managerReportTexts(harness.manager, "manager-1").length === 1);
      await waitForCondition(() => harness.supervisor.spawnCalls.length === 1);

      const session = harness.sessionService.getById("worker-1");
      expect(session).toMatchObject({
        id: "worker-1",
        backend: "claude",
        model: expectedModel,
        cwd: "/tmp/provider-error-handling",
        status: "idle",
      });
      expect(session?.systemPrompt).toContain("Original worker prompt");
      expect(harness.sessionService.getRuntimeConfig("worker-1")).toMatchObject({
        backendConfig: expect.objectContaining({
          thinkingLevel: expectedThinkingLevel,
        }),
      });
      expect(harness.agentRepo.get("worker-1")).toMatchObject({
        sessionId: "worker-1",
        managerSessionId: "manager-1",
        memoryOwnerSessionId: "manager-1",
      });
      expect(workerSendTexts(harness, "worker-1")).toEqual([
        "Investigate the provider failure.",
        "Investigate the provider failure.",
      ]);
      expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
        `SYSTEM: Worker worker-1 auto-fell-back from ${sourcePreset} to ${fallbackPreset} (Anthropic Pi emulation rejected). Session restarting.`,
      ]);

      publishAssistantErrorCompletion(
        harness,
        "worker-1",
        '400 invalid_request_error: "You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."',
      );

      await waitForCondition(() => managerReportTexts(harness.manager, "manager-1").length === 2);

      expect(harness.supervisor.spawnCalls).toEqual(["worker-1"]);
      expect(managerReportTexts(harness.manager, "manager-1")[1]).toBe(
        "SYSTEM: Worker worker-1 errored: Anthropic usage exhausted: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
      );
    },
  );

  it("surfaces a worker-error ping when auto-fallback reconfigure fails", async () => {
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

    const originalReconfigure = harness.sessionService.reconfigure.bind(harness.sessionService);
    harness.sessionService.reconfigure = ((...args) => {
      void args;
      throw new Error("mock reconfigure failure");
    }) as SessionService["reconfigure"];

    publishAssistantErrorCompletion(
      harness,
      "worker-1",
      '400 invalid_request_error: "You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."',
    );

    await waitForCondition(() => managerReportTexts(harness.manager, "manager-1").length === 2);

    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      "SYSTEM: Worker worker-1 auto-fell-back from pi-opus to claude-code (Anthropic Pi emulation rejected). Session restarting.",
      "SYSTEM: Worker worker-1 errored: Auto-fallback to claude-code failed: mock reconfigure failure",
    ]);
    expect(harness.supervisor.spawnCalls).toEqual([]);

    harness.sessionService.reconfigure = originalReconfigure;
  });

  it("does not fallback for non-Pi-Anthropic workers", async () => {
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

    publishAssistantErrorCompletion(
      harness,
      "worker-1",
      '400 invalid_request_error: "You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."',
    );

    await waitForCondition(() => managerReportTexts(harness.manager, "manager-1").length === 1);

    expect(harness.supervisor.spawnCalls).toEqual([]);
    expect(harness.sessionService.getById("worker-1")).toMatchObject({
      backend: "pi",
      model: "openai-codex/gpt-5.4",
    });
    expect(managerReportTexts(harness.manager, "manager-1")).toEqual([
      "SYSTEM: Worker worker-1 errored: Anthropic usage exhausted: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
    ]);
  });
});

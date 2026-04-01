import type { SessionRecord, SwarmdCoreHandle } from "swarmd";

import { normalizeArchetypeId } from "./archetypes/archetype-prompt-registry.js";
import { resolveAgentModelDescriptorFromSession } from "./session-model-descriptor.js";
import type {
  MiddlemanAgentRepo,
  MiddlemanAgentRow,
  MiddlemanManagerOrderRepo,
} from "./swarm-sql.js";
import type { SwarmRuntimeContextService } from "./swarm-runtime-context.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  MessageTargetContext,
  SwarmConfig,
} from "./types.js";

export const MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE = `You are a newly created manager agent for this user.

Send a warm welcome via speak_to_user and explain that you orchestrate worker agents to get work done quickly and safely.

Then run a short onboarding interview. Ask:
1. What kinds of projects/tasks they expect to work on most.
2. Whether they prefer delegation-heavy execution or hands-on collaboration.
3. Which tools matter most (cron scheduling, web search, browser automation, etc.).
4. Any coding/process preferences (style conventions, testing expectations, branching/PR habits).
5. Communication style preferences (concise vs detailed, formal vs casual, update cadence).

Offer this example workflow to show what's possible:

"The Delegator" workflow:
- User describes a feature or task.
- Manager spawns a codex worker in a git worktree branch.
- Worker implements and validates (typecheck, build, tests).
- Merger agent merges the branch to main.
- Multiple independent tasks can run in parallel across separate workers.
- Use different model workers for different strengths (e.g. opus for UI polish, codex for backend).
- Manager focuses on orchestration and concise status updates.
- Memory file tracks preferences, decisions, and project context across sessions.

This is just one example — ask the user how they'd like to work and adapt to their style.

Close by asking if they want you to save their preferences to memory for future sessions.
If they agree, summarize the choices and persist them using the memory workflow.`;

function isPreferredManagerCandidate(descriptor: AgentDescriptor): boolean {
  return descriptor.role === "manager" && descriptor.status !== "terminated";
}

interface SwarmLifecycleServiceOptions {
  config: SwarmConfig;
  now: () => string;
  runtimeContext: SwarmRuntimeContextService;
  getCore: () => SwarmdCoreHandle;
  getAgentRepo: () => MiddlemanAgentRepo;
  getManagerOrderRepo: () => MiddlemanManagerOrderRepo;
}

interface DescriptorGraphCache {
  activeAgentIds: Set<string>;
  rowsById: Map<string, MiddlemanAgentRow>;
  sortedActiveAgentIds: string[];
  sortedAllAgentIds: string[];
  managerOrder: string[];
}

export class SwarmLifecycleService {
  private descriptorGraphCache: DescriptorGraphCache | null = null;

  constructor(private readonly options: SwarmLifecycleServiceOptions) {}

  async createAgentSessionAndRow(input: {
    agentId: string;
    role: "manager" | "worker";
    managerId: string;
    archetypeId?: string;
    cwd: string;
    model: AgentModelDescriptor;
    memoryOwnerAgentId: string;
    systemPrompt?: string;
    replyTarget?: MessageTargetContext;
    preserveMiddlemanRow?: boolean;
  }): Promise<AgentDescriptor> {
    const basePrompt =
      input.systemPrompt?.trim() ||
      this.options.runtimeContext.resolveSystemPromptForDescriptor({
        role: input.role,
        archetypeId: input.archetypeId,
      });
    const resources = await this.options.runtimeContext.resolveRuntimeContextResources({
      agentId: input.agentId,
      role: input.role,
      managerId: input.managerId,
      cwd: input.cwd,
      model: input.model,
      memoryOwnerAgentId: input.memoryOwnerAgentId,
    });
    const runtimeConfig = this.options.runtimeContext.buildRuntimeConfig(
      {
        agentId: input.agentId,
        role: input.role,
        managerId: input.managerId,
        cwd: input.cwd,
        model: input.model,
        memoryOwnerAgentId: input.memoryOwnerAgentId,
      },
      resources,
    );
    const prompt = this.options.runtimeContext.buildSessionSystemPrompt(
      basePrompt,
      runtimeConfig.backend,
      resources,
    );

    this.options.getCore().sessionService.create({
      id: input.agentId,
      backend: runtimeConfig.backend,
      cwd: input.cwd,
      model: runtimeConfig.model,
      displayName: input.agentId,
      systemPrompt: prompt,
      backendConfig: runtimeConfig.backendConfig,
      autoStart: false,
    });
    this.invalidateDescriptorGraphCache();

    if (!input.preserveMiddlemanRow) {
      this.options.getAgentRepo().create({
        sessionId: input.agentId,
        role: input.role,
        managerSessionId: input.managerId,
        archetypeId: input.archetypeId,
        memoryOwnerSessionId: input.memoryOwnerAgentId,
        replyTarget: input.replyTarget,
      });
    } else if (input.replyTarget) {
      this.options.getAgentRepo().updateReplyTarget(input.agentId, input.replyTarget);
    }

    await this.options.getCore().sessionService.start(input.agentId);
    return this.requireDescriptor(input.agentId);
  }

  async deleteAgentSession(
    agentId: string,
    options?: { preserveMiddlemanRow?: boolean },
  ): Promise<void> {
    const session = this.options.getCore().sessionService.getById(agentId);
    if (session) {
      if (session.status !== "terminated" && session.status !== "stopped") {
        await this.terminateSession(agentId);
      }
      this.options.getCore().sessionService.delete(agentId);
      this.invalidateDescriptorGraphCache();
    }

    if (!options?.preserveMiddlemanRow) {
      this.options.getAgentRepo().delete(agentId);
      this.invalidateDescriptorGraphCache();
    }
  }

  async stopSession(agentId: string): Promise<void> {
    const session = this.options.getCore().sessionService.getById(agentId);
    if (!session || session.status === "stopped" || session.status === "terminated") {
      return;
    }

    await this.options.getCore().sessionService.stop(agentId);
  }

  async terminateSession(agentId: string): Promise<void> {
    const session = this.options.getCore().sessionService.getById(agentId);
    if (!session || session.status === "terminated") {
      return;
    }

    await this.options.getCore().sessionService.terminate(agentId);
  }

  async sendManagerBootstrapMessage(
    managerId: string,
    sendMessage: (
      fromAgentId: string,
      targetAgentId: string,
      message: string,
      delivery?: "auto",
    ) => Promise<unknown>,
  ): Promise<void> {
    const manager = this.getAgent(managerId);
    if (!manager || manager.role !== "manager") {
      return;
    }

    try {
      await sendMessage(managerId, managerId, MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE, "auto");
    } catch {
      // Ignore bootstrap prompt failures; manager creation itself already succeeded.
    }
  }

  async ensureManagerOrder(): Promise<void> {
    this.options
      .getManagerOrderRepo()
      .ensure(this.listManagers().map((manager) => manager.agentId));
    this.invalidateDescriptorGraphCache();
  }

  resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return {
      ...this.options.config.defaultModel,
    };
  }

  resolvePreferredManagerId(): string | undefined {
    const managers = this.listManagers();
    const orderedManagerIds = this.getDescriptorGraph().managerOrder;
    const preferredManagers = managers.filter(isPreferredManagerCandidate);

    for (const managerId of orderedManagerIds) {
      if (preferredManagers.some((manager) => manager.agentId === managerId)) {
        return managerId;
      }
    }

    if (preferredManagers.length > 0) {
      return preferredManagers[0]?.agentId;
    }

    for (const managerId of orderedManagerIds) {
      if (managers.some((manager) => manager.agentId === managerId)) {
        return managerId;
      }
    }

    return managers[0]?.agentId;
  }

  listManagers(options?: { includeArchived?: boolean }): AgentDescriptor[] {
    return this.getSortedDescriptors(options).filter((descriptor) => descriptor.role === "manager");
  }

  getSortedDescriptors(options?: { includeArchived?: boolean }): AgentDescriptor[] {
    return this.getSortedDescriptorsInternal(options, true);
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.getAgentInternal(agentId, true);
  }

  invalidateDescriptorGraphCache(): void {
    this.descriptorGraphCache = null;
  }

  requireDescriptor(agentId: string): AgentDescriptor {
    const descriptor = this.getAgent(agentId);
    if (!descriptor) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return descriptor;
  }

  assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.requireDescriptor(agentId);
    if (descriptor.role !== "manager") {
      throw new Error(`Only managers can ${action}.`);
    }
    return descriptor;
  }

  generateUniqueManagerId(name: string): string {
    return this.generateUniqueAgentId(name.trim().replace(/\s+/g, "-"));
  }

  generateUniqueAgentId(candidate: string): string {
    const base = normalizeArchetypeId(candidate) || "agent";
    const existing = new Set(
      this.getSortedDescriptors({ includeArchived: true }).map((agent) => agent.agentId),
    );
    if (!existing.has(base)) {
      return base;
    }

    let index = 2;
    while (existing.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  resolveSpawnWorkerArchetypeId(archetypeId?: string): string | undefined {
    if (!archetypeId?.trim()) {
      return undefined;
    }
    return normalizeArchetypeId(archetypeId);
  }

  private getSortedDescriptorsInternal(
    options: { includeArchived?: boolean } | undefined,
    allowCacheRefresh: boolean,
  ): AgentDescriptor[] {
    const core = this.options.getCore();
    const graph = this.getDescriptorGraph();
    const sessionsById = new Map(
      core.sessionService
        .list({
          includeArchived: options?.includeArchived === true,
        })
        .map((session) => [session.id, session]),
    );
    const agentIds =
      options?.includeArchived === true ? graph.sortedAllAgentIds : graph.sortedActiveAgentIds;
    const descriptors: AgentDescriptor[] = [];
    let isStale = false;

    for (const agentId of agentIds) {
      const row = graph.rowsById.get(agentId);
      const session = sessionsById.get(agentId);
      if (!row || !session) {
        isStale = true;
        continue;
      }
      descriptors.push(buildDescriptor(core, row, session));
    }

    if (isStale && allowCacheRefresh) {
      this.invalidateDescriptorGraphCache();
      return this.getSortedDescriptorsInternal(options, false);
    }

    return descriptors;
  }

  private getAgentInternal(
    agentId: string,
    allowCacheRefresh: boolean,
  ): AgentDescriptor | undefined {
    const graph = this.getDescriptorGraph();
    const core = this.options.getCore();
    const row = graph.rowsById.get(agentId);
    const session = core.sessionService.getById(agentId);
    const isActive = graph.activeAgentIds.has(agentId);

    if (!row || !session || !isActive) {
      if (allowCacheRefresh && (row || session)) {
        this.invalidateDescriptorGraphCache();
        return this.getAgentInternal(agentId, false);
      }
      return undefined;
    }

    return buildDescriptor(core, row, session);
  }

  // Cache the structural agent graph so hot-path lookups only need a single
  // session fetch instead of reloading and sorting every agent on each event.
  private getDescriptorGraph(): DescriptorGraphCache {
    if (this.descriptorGraphCache) {
      return this.descriptorGraphCache;
    }

    const core = this.options.getCore();
    const rows = this.options.getAgentRepo().list();
    const managerOrder = this.options.getManagerOrderRepo().list();
    const sessionsById = new Map(
      core.sessionService.list({ includeArchived: true }).map((session) => [session.id, session]),
    );
    const activeAgentIds = new Set(core.sessionService.list().map((session) => session.id));
    const managerIndexById = new Map(managerOrder.map((managerId, index) => [managerId, index]));
    const rowsById = new Map(rows.map((row) => [row.sessionId, row]));
    const sortedAllAgentIds = rows
      .filter((row) => sessionsById.has(row.sessionId))
      .sort((left, right) => compareAgentRows(left, right, sessionsById, managerIndexById))
      .map((row) => row.sessionId);

    this.descriptorGraphCache = {
      activeAgentIds,
      rowsById,
      sortedActiveAgentIds: sortedAllAgentIds.filter((agentId) => activeAgentIds.has(agentId)),
      sortedAllAgentIds,
      managerOrder,
    };

    return this.descriptorGraphCache;
  }
}

function compareAgentRows(
  left: MiddlemanAgentRow,
  right: MiddlemanAgentRow,
  sessionsById: ReadonlyMap<string, SessionRecord>,
  managerIndexById: ReadonlyMap<string, number>,
): number {
  const leftSession = sessionsById.get(left.sessionId);
  const rightSession = sessionsById.get(right.sessionId);

  if (left.role === "manager" && right.role === "manager") {
    return (
      (managerIndexById.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER) -
      (managerIndexById.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  if (left.role === "manager") {
    return -1;
  }
  if (right.role === "manager") {
    return 1;
  }

  if (left.managerSessionId !== right.managerSessionId) {
    return (
      (managerIndexById.get(left.managerSessionId) ?? Number.MAX_SAFE_INTEGER) -
      (managerIndexById.get(right.managerSessionId) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  if (leftSession?.createdAt !== rightSession?.createdAt) {
    return (leftSession?.createdAt ?? "").localeCompare(rightSession?.createdAt ?? "");
  }

  return left.sessionId.localeCompare(right.sessionId);
}

function buildDescriptor(
  core: Pick<SwarmdCoreHandle, "sessionService">,
  agentRow: MiddlemanAgentRow,
  session: SessionRecord,
): AgentDescriptor {
  return {
    agentId: agentRow.sessionId,
    displayName: session.displayName,
    role: agentRow.role,
    managerId: agentRow.managerSessionId,
    archetypeId: agentRow.archetypeId,
    status: session.status as AgentStatus,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    model: resolveAgentModelDescriptorFromSession(core, session),
    contextUsage: session.contextUsage ?? undefined,
  };
}

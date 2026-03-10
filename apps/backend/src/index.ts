import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { config as loadDotenv } from "dotenv";
import { createConfig, type CreateConfigOptions } from "./config.js";
import { IntegrationRegistryService } from "./integrations/registry.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { getScheduleFilePath } from "./scheduler/schedule-storage.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import type { AgentDescriptor, SwarmConfig } from "./swarm/types.js";
import { SwarmWebSocketServer } from "./ws/server.js";

export interface StartServerOptions extends CreateConfigOptions {
  loadEnvFiles?: boolean;
  registerSignalHandlers?: boolean;
}

export interface StartedMiddlemanServer {
  config: SwarmConfig;
  stop: () => Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedMiddlemanServer> {
  const projectRoot = resolveProjectRootOption(options.projectRoot);
  const dataDir = resolveDataDirOption(options.dataDir);

  if (options.loadEnvFiles !== false) {
    loadRuntimeEnvFiles(projectRoot, dataDir);
  }

  const config = createConfig({
    ...options,
    projectRoot,
    dataDir
  });

  const swarmManager = new SwarmManager(config);
  await swarmManager.boot();

  const schedulersByManagerId = new Map<string, CronSchedulerService>();
  let schedulerLifecycle: Promise<void> = Promise.resolve();

  const syncSchedulers = async (managerIds: Set<string>): Promise<void> => {
    for (const managerId of managerIds) {
      if (schedulersByManagerId.has(managerId)) {
        continue;
      }

      const scheduler = new CronSchedulerService({
        swarmManager,
        schedulesFile: getScheduleFilePath(config.paths.dataDir, managerId),
        managerId
      });
      await scheduler.start();
      schedulersByManagerId.set(managerId, scheduler);
    }

    for (const [managerId, scheduler] of schedulersByManagerId.entries()) {
      if (managerIds.has(managerId)) {
        continue;
      }

      await scheduler.stop();
      schedulersByManagerId.delete(managerId);
    }
  };

  const queueSchedulerSync = (managerIds: Set<string>): Promise<void> => {
    const next = schedulerLifecycle.then(
      () => syncSchedulers(managerIds),
      () => syncSchedulers(managerIds)
    );
    schedulerLifecycle = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  await queueSchedulerSync(collectManagerIds(swarmManager.listAgents(), config.managerId));

  const handleAgentsSnapshot = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      return;
    }

    const payload = event as { type?: string; agents?: unknown };
    if (payload.type !== "agents_snapshot" || !Array.isArray(payload.agents)) {
      return;
    }

    const managerIds = collectManagerIds(payload.agents, config.managerId);
    void queueSchedulerSync(managerIds).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Failed to sync scheduler instances: ${message}`);
    });
  };

  swarmManager.on("agents_snapshot", handleAgentsSnapshot);

  const integrationRegistry = new IntegrationRegistryService({
    swarmManager,
    dataDir: config.paths.dataDir,
    defaultManagerId: config.managerId
  });
  await integrationRegistry.start();

  const wsServer = new SwarmWebSocketServer({
    swarmManager,
    host: config.host,
    port: config.port,
    allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    integrationRegistry,
    uiDir: config.paths.uiDir
  });
  await wsServer.start();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    swarmManager.off("agents_snapshot", handleAgentsSnapshot);
    await Promise.allSettled([
      queueSchedulerSync(new Set<string>()),
      integrationRegistry.stop(),
      wsServer.stop()
    ]);
  };

  if (options.registerSignalHandlers !== false) {
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`Received ${signal}. Shutting down...`);
      await stop();
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    config,
    stop
  };
}

async function main(): Promise<void> {
  const { config } = await startServer();
  console.log(`Middleman listening on http://${config.host}:${config.port}`);
}

function collectManagerIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
  const managerIds = new Set<string>();

  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      continue;
    }

    const descriptor = agent as Partial<AgentDescriptor>;
    if (descriptor.role !== "manager") {
      continue;
    }

    if (typeof descriptor.agentId !== "string" || descriptor.agentId.trim().length === 0) {
      continue;
    }

    managerIds.add(descriptor.agentId.trim());
  }

  const normalizedFallbackManagerId =
    typeof fallbackManagerId === "string" ? fallbackManagerId.trim() : "";
  if (managerIds.size === 0 && normalizedFallbackManagerId.length > 0) {
    managerIds.add(normalizedFallbackManagerId);
  }

  return managerIds;
}

function loadRuntimeEnvFiles(projectRoot: string, dataDir: string): void {
  const projectEnvFile = resolve(projectRoot, ".env");
  const userEnvFile = resolve(dataDir, "config.env");

  for (const envFile of [projectEnvFile, userEnvFile]) {
    if (!existsSync(envFile)) {
      continue;
    }

    loadDotenv({ path: envFile, override: false });
  }
}

function resolveProjectRootOption(projectRoot?: string): string {
  const configuredProjectRoot = projectRoot ?? process.env.MIDDLEMAN_PROJECT_ROOT;
  if (typeof configuredProjectRoot === "string" && configuredProjectRoot.trim().length > 0) {
    return resolve(configuredProjectRoot);
  }

  return resolve(process.cwd());
}

function resolveDataDirOption(dataDir?: string): string {
  const configuredDataDir = dataDir ?? process.env.MIDDLEMAN_HOME;
  if (typeof configuredDataDir === "string" && configuredDataDir.trim().length > 0) {
    return resolve(configuredDataDir);
  }

  return resolve(homedir(), ".middleman");
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  void main().catch((error) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EADDRINUSE"
    ) {
      const config = createConfig();
      console.error(
        `Failed to start backend: http://${config.host}:${config.port} is already in use. ` +
          `Stop the other process or run with MIDDLEMAN_PORT=<port>.`
      );
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}

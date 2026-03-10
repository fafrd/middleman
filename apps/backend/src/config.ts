import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { normalizeAllowlistRoots } from "./swarm/cwd-policy.js";
import { getMemoryDirPath } from "./swarm/memory-paths.js";
import type { SwarmConfig } from "./swarm/types.js";

const CONFIG_DIR = fileURLToPath(new URL(".", import.meta.url));

export interface CreateConfigOptions {
  installDir?: string;
  projectRoot?: string;
  dataDir?: string;
  cliBinDir?: string;
  uiDir?: string;
  host?: string;
  port?: number;
}

export function createConfig(options: CreateConfigOptions = {}): SwarmConfig {
  const installDir = resolveInstallDir(options.installDir);
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const dataDir = resolveDataDir(options.dataDir);
  const installArchetypesDir = resolveInstallArchetypesDir(installDir);
  const installSkillsDir = resolveInstallSkillsDir(installDir);
  const managerId = undefined;
  const configFile = resolve(dataDir, "config.json");
  const configEnvFile = resolve(dataDir, "config.env");
  const runDir = resolve(dataDir, "run");
  const logsDir = resolve(dataDir, "logs");
  const schedulesDir = resolve(dataDir, "schedules");
  const integrationsDir = resolve(dataDir, "integrations");
  const swarmDir = resolve(dataDir, "swarm");
  const sessionsDir = resolve(dataDir, "sessions");
  const uploadsDir = resolve(dataDir, "uploads");
  const authDir = resolve(dataDir, "auth");
  const authFile = resolve(authDir, "auth.json");
  migrateLegacyPiAuthFileIfNeeded(authFile);
  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");
  const projectSwarmDir = resolve(projectRoot, ".swarm");
  const projectArchetypesDir = resolve(projectSwarmDir, "archetypes");
  const projectSkillsDir = resolve(projectSwarmDir, "skills");
  const memoryDir = getMemoryDirPath(dataDir);
  const memoryFile = undefined;
  const projectMemorySkillFile = resolve(projectSkillsDir, "memory", "SKILL.md");
  const secretsFile = resolve(dataDir, "secrets.json");
  const defaultCwd = projectRoot;

  const cwdAllowlistRoots = normalizeAllowlistRoots([
    projectRoot,
    resolve(homedir(), "worktrees")
  ]);

  return {
    host: options.host ?? process.env.MIDDLEMAN_HOST ?? "127.0.0.1",
    port: options.port ?? Number.parseInt(process.env.MIDDLEMAN_PORT ?? "47187", 10),
    debug: true,
    allowNonManagerSubscriptions: true,
    managerId,
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "xhigh"
    },
    defaultCwd,
    cwdAllowlistRoots,
    paths: {
      installDir,
      installAssetsDir: resolve(installArchetypesDir, ".."),
      installArchetypesDir,
      installSkillsDir,
      cliBinDir: resolveCliBinDir(installDir, options.cliBinDir),
      uiDir: resolveUiDir(installDir, options.uiDir),
      projectRoot,
      projectSwarmDir,
      projectArchetypesDir,
      projectSkillsDir,
      projectMemorySkillFile,
      dataDir,
      configFile,
      configEnvFile,
      runDir,
      logsDir,
      schedulesDir,
      integrationsDir,
      swarmDir,
      sessionsDir,
      uploadsDir,
      authDir,
      authFile,
      agentDir,
      managerAgentDir,
      memoryDir,
      memoryFile,
      agentsStoreFile: resolve(swarmDir, "agents.json"),
      secretsFile,
      schedulesFile: undefined
    }
  };
}

function resolveInstallDir(explicitInstallDir?: string): string {
  const configuredInstallDir = explicitInstallDir ?? process.env.MIDDLEMAN_INSTALL_DIR;
  if (typeof configuredInstallDir === "string" && configuredInstallDir.trim().length > 0) {
    return resolve(configuredInstallDir);
  }

  let current = resolve(CONFIG_DIR);
  let nearestPackageRoot: string | null = null;

  while (true) {
    const packageJsonPath = resolve(current, "package.json");
    if (existsSync(packageJsonPath)) {
      if (nearestPackageRoot === null) {
        nearestPackageRoot = current;
      }

      if (readPackageName(packageJsonPath) === "middleman") {
        return current;
      }
    }

    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return nearestPackageRoot ?? resolve(process.cwd());
}

function resolveProjectRoot(explicitProjectRoot?: string): string {
  const configuredProjectRoot = explicitProjectRoot ?? process.env.MIDDLEMAN_PROJECT_ROOT;
  if (typeof configuredProjectRoot === "string" && configuredProjectRoot.trim().length > 0) {
    return resolve(configuredProjectRoot);
  }

  return resolve(process.cwd());
}

function resolveDataDir(explicitDataDir?: string): string {
  const configuredHome = explicitDataDir ?? process.env.MIDDLEMAN_HOME;
  if (typeof configuredHome === "string" && configuredHome.trim().length > 0) {
    return resolve(configuredHome);
  }

  return resolve(homedir(), ".middleman");
}

function resolveInstallArchetypesDir(installDir: string): string {
  return resolveFirstExistingPath([
    resolve(installDir, "assets", "archetypes"),
    resolve(installDir, "apps", "backend", "dist", "assets", "archetypes"),
    resolve(installDir, "apps", "backend", "src", "swarm", "archetypes", "builtins")
  ]);
}

function resolveInstallSkillsDir(installDir: string): string {
  return resolveFirstExistingPath([
    resolve(installDir, "assets", "skills"),
    resolve(installDir, "apps", "backend", "dist", "assets", "skills"),
    resolve(installDir, "apps", "backend", "src", "swarm", "skills", "builtins")
  ]);
}

function resolveCliBinDir(installDir: string, explicitCliBinDir?: string): string {
  const configuredCliBinDir = explicitCliBinDir ?? process.env.MIDDLEMAN_CLI_BIN_DIR;
  if (typeof configuredCliBinDir === "string" && configuredCliBinDir.trim().length > 0) {
    return resolve(configuredCliBinDir);
  }

  return resolveFirstExistingPath([
    resolve(installDir, "bin"),
    resolve(installDir, "apps", "cli", "bin")
  ]);
}

function resolveUiDir(installDir: string, explicitUiDir?: string): string {
  const configuredUiDir = explicitUiDir ?? process.env.MIDDLEMAN_UI_DIR;
  if (typeof configuredUiDir === "string" && configuredUiDir.trim().length > 0) {
    return resolve(configuredUiDir);
  }

  return resolveFirstExistingPath([
    resolve(installDir, "ui"),
    resolve(installDir, "apps", "backend", "dist", "public"),
    resolve(installDir, "apps", "ui", ".output", "public")
  ]);
}

function resolveFirstExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? resolve(process.cwd());
}

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return typeof packageJson.name === "string" ? packageJson.name : undefined;
  } catch {
    return undefined;
  }
}

function migrateLegacyPiAuthFileIfNeeded(targetAuthFile: string): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return;
  }

  const legacyPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(targetAuthFile) || !existsSync(legacyPiAuthFile)) {
    return;
  }

  try {
    mkdirSync(dirname(targetAuthFile), { recursive: true });
    copyFileSync(legacyPiAuthFile, targetAuthFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[swarm] Failed to migrate legacy Pi auth file: ${message}`);
  }
}

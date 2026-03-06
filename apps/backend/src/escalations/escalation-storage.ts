import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { UserEscalation, UserEscalationResponse } from "../swarm/types.js";

const ESCALATIONS_FILE_NAME = "escalations.json";

interface EscalationsFile {
  escalations: UserEscalation[];
}

function cloneResponse(response: UserEscalationResponse | undefined): UserEscalationResponse | undefined {
  if (!response) {
    return undefined;
  }

  return {
    choice: response.choice,
    isCustom: response.isCustom
  };
}

function cloneEscalation(escalation: UserEscalation): UserEscalation {
  return {
    ...escalation,
    options: [...escalation.options],
    response: cloneResponse(escalation.response)
  };
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return trimmed;
}

function normalizeOptions(candidate: unknown): string[] {
  if (!Array.isArray(candidate)) {
    throw new Error("options must be an array");
  }

  const normalized = candidate.map((option) => {
    if (typeof option !== "string") {
      throw new Error("options must contain only strings");
    }

    return option.trim();
  });

  if (normalized.length === 0) {
    throw new Error("options must include at least one option");
  }

  if (normalized.some((option) => option.length === 0)) {
    throw new Error("options must not contain blank values");
  }

  return normalized;
}

function compareEscalations(left: UserEscalation, right: UserEscalation): number {
  if (left.status !== right.status) {
    return left.status === "open" ? -1 : 1;
  }

  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt);
  }

  return right.id.localeCompare(left.id);
}

function validateResponse(candidate: unknown): UserEscalationResponse | undefined {
  if (candidate === undefined) {
    return undefined;
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const response = candidate as Partial<UserEscalationResponse>;
  if (
    typeof response.choice !== "string" ||
    response.choice.trim().length === 0 ||
    typeof response.isCustom !== "boolean"
  ) {
    return undefined;
  }

  return {
    choice: response.choice.trim(),
    isCustom: response.isCustom
  };
}

function validateEscalation(candidate: unknown): UserEscalation | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }

  const escalation = candidate as Partial<UserEscalation>;
  if (
    typeof escalation.id !== "string" ||
    escalation.id.trim().length === 0 ||
    typeof escalation.managerId !== "string" ||
    escalation.managerId.trim().length === 0 ||
    typeof escalation.title !== "string" ||
    escalation.title.trim().length === 0 ||
    typeof escalation.description !== "string" ||
    escalation.description.trim().length === 0 ||
    (escalation.status !== "open" && escalation.status !== "resolved") ||
    typeof escalation.createdAt !== "string" ||
    escalation.createdAt.trim().length === 0 ||
    (escalation.resolvedAt !== undefined &&
      (typeof escalation.resolvedAt !== "string" || escalation.resolvedAt.trim().length === 0))
  ) {
    return undefined;
  }

  let options: string[];
  try {
    options = normalizeOptions(escalation.options);
  } catch {
    return undefined;
  }

  const response = validateResponse(escalation.response);
  if (escalation.response !== undefined && !response) {
    return undefined;
  }

  return {
    id: escalation.id.trim(),
    managerId: escalation.managerId.trim(),
    title: escalation.title.trim(),
    description: escalation.description.trim(),
    options,
    status: escalation.status,
    response,
    createdAt: escalation.createdAt.trim(),
    resolvedAt: escalation.resolvedAt?.trim()
  };
}

export function getEscalationsFilePath(dataDir: string): string {
  return resolve(dataDir, ESCALATIONS_FILE_NAME);
}

export class EscalationStorage {
  private readonly filePath: string;
  private readonly escalations = new Map<string, UserEscalation>();

  constructor(
    private readonly options: {
      dataDir: string;
      now: () => string;
      generateId?: () => string;
    }
  ) {
    this.filePath = getEscalationsFilePath(options.dataDir);
  }

  async load(): Promise<void> {
    this.escalations.clear();

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<EscalationsFile>;
      const storedEscalations = Array.isArray(parsed.escalations) ? parsed.escalations : [];

      for (const candidate of storedEscalations) {
        const escalation = validateEscalation(candidate);
        if (!escalation) {
          continue;
        }

        this.escalations.set(escalation.id, escalation);
      }
    } catch {
      // Missing or invalid escalation files should not block boot.
    }
  }

  listAll(): UserEscalation[] {
    return Array.from(this.escalations.values()).map(cloneEscalation).sort(compareEscalations);
  }

  get(escalationId: string): UserEscalation | undefined {
    const escalation = this.escalations.get(escalationId);
    return escalation ? cloneEscalation(escalation) : undefined;
  }

  listForManager(managerId: string, status: "open" | "resolved" | "all" = "all"): UserEscalation[] {
    return this.listAll().filter((escalation) => {
      if (escalation.managerId !== managerId) {
        return false;
      }

      return status === "all" ? true : escalation.status === status;
    });
  }

  async create(input: {
    managerId: string;
    title: string;
    description: string;
    options: string[];
  }): Promise<UserEscalation> {
    const escalation: UserEscalation = {
      id: this.options.generateId?.() ?? randomUUID(),
      managerId: normalizeRequiredText(input.managerId, "managerId"),
      title: normalizeRequiredText(input.title, "title"),
      description: normalizeRequiredText(input.description, "description"),
      options: normalizeOptions(input.options),
      status: "open",
      createdAt: this.options.now()
    };

    this.escalations.set(escalation.id, escalation);
    await this.save();
    return cloneEscalation(escalation);
  }

  async resolve(escalationId: string, response?: UserEscalationResponse): Promise<UserEscalation> {
    const existing = this.escalations.get(escalationId);
    if (!existing) {
      throw new Error(`Unknown escalation: ${escalationId}`);
    }

    if (existing.status === "resolved") {
      return cloneEscalation(existing);
    }

    let normalizedResponse: UserEscalationResponse | undefined;
    if (response) {
      normalizedResponse = {
        choice: normalizeRequiredText(response.choice, "choice"),
        isCustom: response.isCustom
      };
    }

    const resolvedEscalation: UserEscalation = {
      ...existing,
      status: "resolved",
      response: normalizedResponse,
      resolvedAt: this.options.now()
    };

    this.escalations.set(escalationId, resolvedEscalation);
    await this.save();
    return cloneEscalation(resolvedEscalation);
  }

  async deleteForManager(managerId: string): Promise<string[]> {
    const deletedEscalationIds: string[] = [];

    for (const [escalationId, escalation] of this.escalations.entries()) {
      if (escalation.managerId !== managerId) {
        continue;
      }

      this.escalations.delete(escalationId);
      deletedEscalationIds.push(escalationId);
    }

    if (deletedEscalationIds.length > 0) {
      await this.save();
    }

    return deletedEscalationIds.sort((left, right) => left.localeCompare(right));
  }

  private async save(): Promise<void> {
    const payload: EscalationsFile = {
      escalations: Array.from(this.escalations.values()).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      )
    };

    const tmpPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}

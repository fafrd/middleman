import {
  inferManagerModelPresetFromDescriptor,
  supportsManualCompactionForDescriptor,
  type AgentDescriptor,
  type ManagerModelPreset,
} from "@middleman/protocol";

export function inferModelPreset(agent: AgentDescriptor): ManagerModelPreset | undefined {
  return inferManagerModelPresetFromDescriptor(agent.model);
}

export function supportsManualCompaction(agent: AgentDescriptor): boolean {
  return supportsManualCompactionForDescriptor(agent.model);
}

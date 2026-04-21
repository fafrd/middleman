import { describe, expect, it } from "vitest";

import type { AgentDescriptor, ConversationEntry } from "@middleman/protocol";

import { deriveVisibleMessages } from "./visible-messages";

function makeManager(agentId: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager",
    status: "idle",
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    },
  };
}

function makeWorker(agentId: string, managerId: string): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: "worker",
    status: "idle",
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh",
    },
  };
}

describe("deriveVisibleMessages", () => {
  it("includes subordinate worker tool activity in manager-visible messages", () => {
    const manager = makeManager("manager-1");
    const worker = makeWorker("worker-1", manager.agentId);
    const messages: ConversationEntry[] = [
      {
        type: "conversation_message",
        agentId: manager.agentId,
        role: "user",
        text: "hello",
        timestamp: "2026-03-15T00:00:01.000Z",
        historyCursor: "2026-03-15T00:00:01.000Z|manager-1|message-1",
        source: "user_input",
      },
    ];
    const activityMessages: ConversationEntry[] = [
      {
        type: "agent_tool_call",
        agentId: manager.agentId,
        actorAgentId: worker.agentId,
        timestamp: "2026-03-15T00:00:02.000Z",
        historyCursor: "2026-03-15T00:00:02.000Z|manager-1|tool-1",
        kind: "tool_execution_end",
        toolName: "bash",
        toolCallId: "tool-1",
        text: '{"stdout":"/tmp/project"}',
      },
    ];

    const visible = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      showInternalChatter: true,
    });

    expect(visible.visibleMessages).toEqual([
      expect.objectContaining({
        type: "conversation_message",
        text: "hello",
      }),
      expect.objectContaining({
        type: "agent_tool_call",
        actorAgentId: worker.agentId,
        toolName: "bash",
        text: '{"stdout":"/tmp/project"}',
      }),
    ]);
  });

  it("hides subordinate worker tool activity for managers when internal chatter is disabled", () => {
    const manager = makeManager("manager-1");
    const worker = makeWorker("worker-1", manager.agentId);
    const messages: ConversationEntry[] = [
      {
        type: "conversation_message",
        agentId: manager.agentId,
        role: "user",
        text: "hello",
        timestamp: "2026-03-15T00:00:01.000Z",
        historyCursor: "2026-03-15T00:00:01.000Z|manager-1|message-1",
        source: "user_input",
      },
    ];
    const activityMessages: ConversationEntry[] = [
      {
        type: "agent_tool_call",
        agentId: manager.agentId,
        actorAgentId: worker.agentId,
        timestamp: "2026-03-15T00:00:02.000Z",
        historyCursor: "2026-03-15T00:00:02.000Z|manager-1|tool-1",
        kind: "tool_execution_end",
        toolName: "bash",
        toolCallId: "tool-1",
        text: '{"stdout":"/tmp/project"}',
      },
    ];

    const visible = deriveVisibleMessages({
      messages,
      activityMessages,
      agents: [manager, worker],
      activeAgent: manager,
      showInternalChatter: false,
    });

    expect(visible.visibleMessages).toEqual(messages);
  });
});

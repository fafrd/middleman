import { describe, expect, it } from "vitest";

import { parseClientCommand } from "../ws/ws-command-parser.js";

describe("parseClientCommand create_manager", () => {
  it("defaults the manager model to pi-codex when omitted", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "create_manager",
            name: "Ops",
            cwd: "/tmp/project",
          }),
        ),
      ),
    ).toEqual({
      ok: true,
      command: {
        type: "create_manager",
        name: "Ops",
        cwd: "/tmp/project",
        model: "pi-codex",
        requestId: undefined,
      },
    });
  });

  it.each(["codex-app", "claude-code"] as const)("rejects %s for manager creation", (model) => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "create_manager",
            name: "Ops",
            cwd: "/tmp/project",
            model,
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      error: "create_manager.model must be one of pi-codex|pi-opus",
    });
  });
});

describe("parseClientCommand interrupt_agent", () => {
  it("parses a valid interrupt_agent command", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "interrupt_agent",
            agentId: "worker-1",
            requestId: "req-1",
          }),
        ),
      ),
    ).toEqual({
      ok: true,
      command: {
        type: "interrupt_agent",
        agentId: "worker-1",
        requestId: "req-1",
      },
    });
  });

  it("rejects interrupt_agent without a non-empty agent id", () => {
    expect(
      parseClientCommand(
        Buffer.from(
          JSON.stringify({
            type: "interrupt_agent",
            agentId: "   ",
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      error: "interrupt_agent.agentId must be a non-empty string",
    });
  });
});

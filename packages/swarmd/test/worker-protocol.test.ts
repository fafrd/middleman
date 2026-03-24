import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  LineReader,
  LineWriter,
  decodeMessage,
  encodeMessage,
} from "../src/core/supervisor/worker-protocol.js";
import type { WorkerCommand, WorkerEvent } from "../src/core/types/index.js";

class BrokenPipeStream extends EventEmitter {
  writes = 0;

  write(_chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes += 1;

    const error = Object.assign(new Error("broken pipe"), {
      code: "EPIPE",
    });

    callback?.(error);
    this.emit("error", error);
    return false;
  }
}

describe("worker protocol", () => {
  it("round-trips commands and events through the JSONL codec", () => {
    const command: WorkerCommand = { type: "stop", operationId: "operation-stop" };
    const event: WorkerEvent = {
      type: "session_status",
      status: "errored",
      error: {
        code: "RUNTIME_FAILED",
        message: "Worker exited before ready.",
        retryable: true,
      },
      contextUsage: {
        tokens: 512,
        contextWindow: 1_048_576,
        percent: 0.0488,
      },
    };

    expect(decodeMessage(encodeMessage(command))).toEqual(command);
    expect(decodeMessage(encodeMessage(event))).toEqual(event);
  });

  it("round-trips explicit context-usage clears", () => {
    const event: WorkerEvent = {
      type: "session_status",
      status: "idle",
      contextUsage: null,
    };

    expect(decodeMessage(encodeMessage(event))).toEqual(event);
  });

  it("reads complete lines from a chunked readable stream", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream);

    const linesPromise = (async () => {
      const lines: string[] = [];
      for await (const line of reader) {
        lines.push(line);
      }
      return lines;
    })();

    stream.write('{"type":"stop","operationId":"operation-stop"}\n{"type":"session_status"');
    stream.end(',"status":"idle"}\r\n{"type":"terminate","operationId":"operation-terminate"}');

    await expect(linesPromise).resolves.toEqual([
      '{"type":"stop","operationId":"operation-stop"}',
      '{"type":"session_status","status":"idle"}',
      '{"type":"terminate","operationId":"operation-terminate"}',
    ]);
  });

  it("writes JSONL messages to a writable stream", () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk) => {
      chunks.push(chunk.toString());
    });

    const writer = new LineWriter(stream);
    writer.send({ type: "interrupt", operationId: "operation-interrupt" });
    writer.send({ type: "session_status", status: "idle" });

    expect(chunks.join("")).toBe(
      '{"type":"interrupt","operationId":"operation-interrupt"}\n{"type":"session_status","status":"idle"}\n',
    );
  });

  it("swallows broken-pipe writes after the other end closes", () => {
    const stream = new BrokenPipeStream();
    const writer = new LineWriter(stream as unknown as NodeJS.WritableStream);

    expect(() =>
      writer.send({ type: "terminate", operationId: "operation-terminate" }),
    ).not.toThrow();
    expect(() => writer.send({ type: "session_status", status: "idle" })).not.toThrow();

    expect(stream.writes).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  classifyRuntimeErrorMessage,
  formatRuntimeErrorMessage,
} from "../swarm/runtime-error-classifier.js";

describe("runtime error classifier", () => {
  it("classifies Anthropic extra-usage exhaustion errors", () => {
    const message =
      '400 invalid_request_error: "You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."';

    expect(classifyRuntimeErrorMessage(message)).toEqual({
      kind: "provider_usage_exhausted",
      provider: "anthropic",
      displayMessage:
        "Anthropic usage exhausted: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
    });
  });

  it.each([
    'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. Please include request ID abc in your message.","param":null},"sequence_number":2}',
    "500 Internal Server Error",
    "request failed with status 503 from provider",
    "ETIMEDOUT while contacting provider",
    "connect ESOCKETTIMEDOUT api.openai.com:443",
    "socket hang up",
    "read ECONNRESET",
    "connect ECONNREFUSED 127.0.0.1:443",
    "getaddrinfo EAI_AGAIN api.openai.com",
    '429 {"error":{"code":"server_error","message":"temporary upstream issue"}}',
  ])("classifies Codex-shaped transient provider failures: %s", (message) => {
    expect(classifyRuntimeErrorMessage(message)).toEqual({
      kind: "transient_provider_failure",
      provider: message.toLowerCase().includes("codex") ? "openai-codex" : "unknown",
      displayMessage: message,
    });
    expect(formatRuntimeErrorMessage(message)).toBe(message);
  });

  it.each([
    "429 insufficient_quota",
    "rate limit exceeded",
    "This operation was aborted",
    "terminated",
    "401 Unauthorized",
    "403 Forbidden",
    "400 invalid_request_error",
    "timed out",
    "request timed out by user",
    "TimeoutError: something generic",
  ])("does not classify terminal/non-transient provider errors: %s", (message) => {
    expect(classifyRuntimeErrorMessage(message)).toBeNull();
    expect(formatRuntimeErrorMessage(message)).toBe(message);
  });

  it("leaves unrelated runtime errors unchanged", () => {
    const message = "Missing authentication for anthropic. Configure credentials in Settings.";

    expect(classifyRuntimeErrorMessage(message)).toBeNull();
    expect(formatRuntimeErrorMessage(message)).toBe(message);
  });
});

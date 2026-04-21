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

  it("leaves unrelated runtime errors unchanged", () => {
    const message = "Missing authentication for anthropic. Configure credentials in Settings.";

    expect(classifyRuntimeErrorMessage(message)).toBeNull();
    expect(formatRuntimeErrorMessage(message)).toBe(message);
  });
});

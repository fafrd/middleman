export interface RuntimeErrorClassification {
  kind: "provider_usage_exhausted";
  provider: "anthropic";
  displayMessage: string;
}

export function classifyRuntimeErrorMessage(message: string): RuntimeErrorClassification | null {
  const normalized = normalizeRuntimeErrorMessage(message);
  if (normalized.length === 0) {
    return null;
  }

  if (isAnthropicUsageExhaustedMessage(normalized)) {
    return {
      kind: "provider_usage_exhausted",
      provider: "anthropic",
      displayMessage:
        "Anthropic usage exhausted: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
    };
  }

  return null;
}

export function formatRuntimeErrorMessage(message: string): string {
  const classification = classifyRuntimeErrorMessage(message);
  return classification?.displayMessage ?? message;
}

function normalizeRuntimeErrorMessage(message: string): string {
  return message.trim().replace(/\s+/gu, " ").toLowerCase();
}

function isAnthropicUsageExhaustedMessage(message: string): boolean {
  return (
    message.includes("you're out of extra usage") && message.includes("claude.ai/settings/usage")
  );
}

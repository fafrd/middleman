export interface ProviderUsageExhaustedClassification {
  kind: "provider_usage_exhausted";
  provider: "anthropic";
  displayMessage: string;
}

export interface TransientProviderFailureClassification {
  kind: "transient_provider_failure";
  provider: "openai-codex" | "unknown";
  displayMessage: string;
}

export type RuntimeErrorClassification =
  | ProviderUsageExhaustedClassification
  | TransientProviderFailureClassification;

const PI_TRANSIENT_HTTP_STATUS_PATTERN = /\b5\d{2}\b/u;
const PI_TRANSIENT_PROVIDER_CODE_PATTERNS = [/\bserver_error\b/u] as const;
const PI_TRANSIENT_NETWORK_ERROR_PATTERNS = [
  /\betimedout\b/u,
  /\besockettimedout\b/u,
  /socket hang up/u,
  /\beconnreset\b/u,
  /\beconnrefused\b/u,
  /\beai_again\b/u,
] as const;

export function classifyRuntimeErrorMessage(message: string): RuntimeErrorClassification | null {
  const trimmed = message.trim();
  const normalized = normalizeRuntimeErrorMessage(trimmed);
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

  if (isTransientProviderFailureMessage(normalized)) {
    return {
      kind: "transient_provider_failure",
      provider: normalized.includes("codex") ? "openai-codex" : "unknown",
      displayMessage: trimmed,
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

function isTransientProviderFailureMessage(message: string): boolean {
  return (
    PI_TRANSIENT_HTTP_STATUS_PATTERN.test(message) ||
    PI_TRANSIENT_PROVIDER_CODE_PATTERNS.some((pattern) => pattern.test(message)) ||
    PI_TRANSIENT_NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  );
}

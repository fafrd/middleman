# Fix Progress — Middleman Orchestration Gap

Based on PLAN.md investigation findings.

## Fixes

| # | Severity | Description | Status |
|---|----------|-------------|--------|
| 1 | Critical | Re-deliver orphaned steers on turn completion (`codex-agent-runtime.ts`) | ✅ Done |
| 2 | High | Notify manager when worker turn completes (`swarm-manager.ts` `handleRuntimeAgentEnd`) | ✅ Done |
| 3 | Medium | Route delivery-failure errors to manager's conversation feed | ✅ Done |
| 4 | Medium | `pushInput` silent-drop guard in `claude-code-runtime.ts` | ✅ Done |
| 5 | Low–Med | Stale-streaming watchdog | ✅ Done |
| 6 | Low | Worker system-prompt guidance on compound shell wrappers | ✅ Done |

---

## Fix 1 — Orphaned steer re-delivery (Critical)
**File:** `apps/backend/src/swarm/codex-agent-runtime.ts`
**Problem:** `turn/completed` handler clears `activeTurnId` and goes idle without checking `queuedSteers`. Any messages queued while the turn was active are silently dropped.
**Fix:** After clearing `activeTurnId`, if `queuedSteers` is non-empty, shift the first one off and start a new turn with it rather than going idle. Remaining steers are flushed by `startTurn → flushSteersIfPossible`. Skip `onAgentEnd` so manager isn't incorrectly told the worker is idle.

## Fix 2 — Manager notification on worker turn end (High)
**File:** `apps/backend/src/swarm/swarm-manager.ts`
**Problem:** `handleRuntimeAgentEnd` is a no-op. When a worker finishes its turn the manager has no automatic signal and must rely on the worker calling back — which can't happen if a message was dropped.
**Fix:** Implement `handleRuntimeAgentEnd` to look up the worker's `managerId` and send the manager a lightweight system message so its model context knows the worker is idle.

## Fix 3 — Error routing to manager feed (Medium)
**File:** `apps/backend/src/swarm/swarm-manager.ts`
**Problem:** `handleRuntimeError` emits the error only to the worker's conversation feed. The manager's model never sees dropped-message errors.
**Fix:** When `droppedPendingCount > 0` and the affected agent is a worker, additionally emit the error to the manager's conversation feed.

## Fix 4 — `pushInput` silent-drop guard (Medium)
**File:** `apps/backend/src/swarm/claude-code-runtime.ts`
**Problem:** If `inputDone` is set between the `isProcessing` check and the `pushInput` call, the message is silently dropped.
**Fix:** After `pushInput`, check if the message was actually enqueued (i.e. `inputDone` wasn't set). If it was dropped, report a runtime error so the caller knows delivery failed.

## Fix 5 — Stale-streaming watchdog (Low–Medium)
**File:** `apps/backend/src/swarm/swarm-manager.ts`
**Problem:** Workers stuck on compound shell commands appear `streaming` indefinitely. The manager sees them as busy and can't tell something is wrong.
**Fix:** Added `startStaleStreamingWatchdog()` called from `boot()`. Checks every 60 s for agents that have been `streaming` for > 15 minutes (using `descriptor.updatedAt` which is set when status transitions to streaming). Emits a warning to both the agent's own feed and, for workers, to the owning manager's feed. Each agent is only warned once per streaming stretch (cleared when status changes).

## Fix 6 — Worker system-prompt guidance (Low)
**File:** `apps/backend/src/swarm/swarm-manager.ts` (`DEFAULT_WORKER_SYSTEM_PROMPT`)
**Problem:** Workers ran compound bash commands (background server + poll + build + kill) that kept the turn streaming for minutes and caused orphaned processes.
**Fix:** Added a "Shell command guidance" section to the default worker system prompt explicitly discouraging compound shell wrappers and requiring `send_message_to_agent` to be called immediately after launching a background server.

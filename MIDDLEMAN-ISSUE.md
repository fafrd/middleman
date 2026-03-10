# Middleman Orchestration Gap — Investigation Report

**Date:** 2026-03-10  
**Investigator:** middleman-issue-investigator (Claude Opus worker)  
**Session under investigation:** Jerry manager session, 2026-03-08 21:44 → 2026-03-10 04:18 UTC

---

## Executive Summary

During a multi-agent coding session orchestrated by the `jerry` manager, **repeated reviewer-pickup failures** caused visible idle periods where the user expected progress but saw none. The manager would send a review task to a reviewer agent, receive a delivery receipt indicating success, but the reviewer would not visibly begin work—or its results would never arrive back at the manager. The user had to explicitly call out stalled reviewers on multiple occasions, prompting the manager to reroute tasks to fallback agents.

In addition, **compound shell wrappers and nohup-style long-lived process launches** caused worker agents to remain in a `streaming` status long after their actual task was complete, blocking the orchestration pipeline and consuming manager attention.

Root causes are structural: (1) the swarm's `send_message_to_agent` returns an optimistic delivery receipt without guaranteeing the message will actually be processed, (2) steer-queued messages can be silently dropped during turn-completion race conditions, (3) dropped-message errors are emitted to the *worker's* conversation feed rather than the *manager's* model context, and (4) `handleRuntimeAgentEnd` is a no-op, so the manager agent has no automatic notification when a worker finishes a turn—it relies entirely on workers calling `send_message_to_agent` back.

---

## Incident Timeline

All timestamps are UTC, 2026-03-09 unless otherwise noted.

### Phase 1: Session Bootstrap (00:36 – 00:51)

| Time | Event | Agent(s) |
|------|-------|----------|
| 00:36:09 | `gm-planner` spawned, terminated almost immediately | gm-planner |
| 00:36:20 | `gm-planner-2` spawned as replacement planner/reviewer | gm-planner-2 |
| 00:45:55 | `gm-merger` spawned (merger archetype) | gm-merger |
| 00:46:56 | `gm-api-docs`, `gm-listener-research`, `gm-backend-foundation` spawned in parallel | gm-api-docs, gm-listener-research, gm-backend-foundation |
| 00:51:28 | `gm-listener-research` finished (short research task, idle at 33k tokens) | gm-listener-research |

### Phase 2: First Build + Review Cycles (01:00 – 04:30)

| Time | Event | Agent(s) |
|------|-------|----------|
| 01:01 | `gm-api-docs` commits API usage docs | gm-api-docs |
| 01:06 | Merge `docs/gm-api-usage` to main | gm-merger |
| 01:48–01:59 | `gm-backend-foundation` commits backend foundation | gm-backend-foundation |
| 02:01 | Merge `feat/backend-foundation` to main | gm-merger |
| 02:03:14 | `gm-ui-dashboard` spawned (Opus model, for UI work) | gm-ui-dashboard |
| 02:11–02:18 | UI dashboard foundation committed | gm-ui-dashboard |
| 03:03–03:13 | Runtime API committed | gm-backend-foundation / gm-planner-2 |
| 03:17 | Merge `feat/runtime-api` to main | gm-merger |
| **03:36:09** | **`gm-ui-live` spawned** (Opus model, for live data UI work) | gm-ui-live |
| 03:44 | `feat/ui-live-data` branch: wire dashboard to real API | gm-ui-live |
| **04:07:47** | **`gm-ui-dashboard` terminated** (context exhaustion or task complete) | gm-ui-dashboard |

**⚠️ Review gap window #1** — Between ~03:44 (ui-live-data branch active) and ~04:23 (next commits on that branch), there is a gap where the `feat/ui-live-data` review path was likely blocked. The `gm-planner-2` agent was expected to review but did not visibly pick up the task. Evidence:
- `gm-ui-live` produced commits on `feat/ui-live-data` at 03:44, 04:19, 04:23
- No merge of `feat/ui-live-data` exists — the branch was superseded by `feat/ui-real-polish` at 04:37
- The manager likely queued a review to `gm-planner-2` which was either still processing a previous turn or whose steer delivery was dropped

### Phase 3: Data Integration and Compound Shell Issues (04:30 – 05:35)

| Time | Event | Agent(s) |
|------|-------|----------|
| 04:29 | Merge `feat/real-data-runtime` | gm-merger |
| 04:34 | Evidence of compound shell wrappers in `/tmp/gm-main-*.log` — multiple API starts, port conflicts (EADDRINUSE), SIGTERM sequences | gm-backend-foundation, gm-backend-resume |
| 04:44–04:51 | API dev server logs show start→SIGINT cycles within 3 minutes, consistent with compound `background API & build & kill` pattern | gm-backend-foundation |
| **05:10:04** | **`gm-backend-foundation` terminated** (likely after worker hung on compound shell, required interrupt) | gm-backend-foundation |
| **05:19:21** | **`gm-backend-resume` spawned** to continue from existing worktree state | gm-backend-resume |
| 05:28 | `gm-backend-resume` commits on `feat/main-live-verify` | gm-backend-resume |
| 05:35 | Merge `feat/main-live-verify` | gm-merger |

**⚠️ Compound shell hang** — `gm-backend-foundation` ran compound bash commands that backgrounded an API dev server, polled health, ran `web:build`, then attempted `kill`/`wait`. Evidence from `/tmp/gm-main-api-for-webbuild.log` shows the API starting at 04:44:53 and receiving SIGINT at 04:47:50 (a 3-minute gap for what should be a build step). Port conflict evidence in `/tmp/gm-main-api.log` (`EADDRINUSE 127.0.0.1:3001`) shows orphaned processes from earlier iterations. The worker stayed `streaming` during this period, unable to process incoming messages. The manager eventually hard-interrupted and spawned `gm-backend-resume` at 05:19.

### Phase 4: Systemd Launch and Streaming UI (05:42 – 07:09)

| Time | Event | Agent(s) |
|------|-------|----------|
| **05:42:07** | **`gm-systemd-launch` spawned** (Opus model) | gm-systemd-launch |
| 05:45–06:10 | Systemd unit files committed, productionalized | gm-systemd-launch |
| 06:19 | SSE stream backend committed | gm-backend-resume / gm-planner-2 |
| 06:23 | Merge `feat/live-streaming-backend` | gm-merger |
| 06:46–07:01 | Stream UI dev server logs: multiple start cycles at `/tmp/gm-stream-ui-api*.log` and `/tmp/gm-stream-ui-web*.log` | gm-ui-live |
| **07:00:12** | **`gm-ui-live` goes idle** (93.4% context utilization — near exhaustion) | gm-ui-live |
| **07:09:07** | **`gm-systemd-launch` goes idle** | gm-systemd-launch |

**⚠️ Nohup/server-launch streaming quirk** — Evidence from `/tmp/gm-stream-ui-web3.log` shows Next.js starting at `localhost:3111` and remaining ready. The worker launched this via `nohup` or similar background mechanism but stayed in `streaming` status because the bash tool call hadn't returned to the runtime. The service was reachable, but the agent appeared busy. Manager had to treat the server as live despite the `streaming` status.

**⚠️ Review gap window #2** — Between the stream UI work completion (~07:00) and the ops-hardening work (~21:30), there is a ~14.5-hour gap. The `feat/live-streaming-ui` branch (last commit 06:59:50) was never merged to main — `main` HEAD is the SSE commit at 06:59:50 which was pushed directly. The UI streaming review likely stalled.

### Phase 5: Ops Hardening and Final Review Cycle (21:20 – 21:45)

| Time | Event | Agent(s) |
|------|-------|----------|
| 21:20 | Worktree `gm-ops-hardening` created | gm-backend-resume |
| 21:30:07 | Systemd services restarted (all three: api, listener, web) | (systemd) |
| **21:32:16** | `gm-backend-resume` commits ops-hardening, goes idle at 21:32:57 | gm-backend-resume |
| **21:40:29** | `gm-planner-2` updated (reviewer activity) | gm-planner-2 |
| **21:40:36** | `gm-merger` updated (merge activity) | gm-merger |
| **21:45:35** | `gm-api-docs` updated (fallback reviewer activity) | gm-api-docs |

**⚠️ Review gap window #3** — The ops-hardening review. Between `gm-backend-resume` finishing at 21:32 and `gm-planner-2` updating at 21:40, there is an 8-minute gap. Given the manager memory entry ("If a queued reviewer task is not visibly running, verify pickup and reroute explicitly"), this was likely another instance where the initial review message to `gm-planner-2` didn't trigger visible activity, and the manager had to verify/reroute. The fact that `gm-api-docs` (fallback reviewer) was updated 5 minutes *after* `gm-planner-2` suggests the manager sent the review first to `gm-planner-2`, then when that appeared stuck, also engaged `gm-api-docs` as a fallback reviewer.

---

## Observed Symptoms

1. **Silent review non-pickup:** Manager sends a review task via `send_message_to_agent`, receives a `mode=steer` receipt, but the reviewer does not start visible work. The manager assumes the review is active; the user sees no progress.

2. **Streaming-state hangs on long-lived processes:** Workers that launch dev servers or use compound shell wrappers (background + poll + build + kill) remain in `streaming` status indefinitely, blocking all incoming messages as queued steers.

3. **Manager-user expectation divergence:** The manager (jerry) reports task delegation as complete based on the delivery receipt, but actual work hasn't started on the worker side. The user observes idle periods until they escalate.

4. **Fallback/reroute pattern:** The manager learns (through user feedback) to verify reviewer pickup and reroute to standby agents, but this is a reactive workaround rather than a systematic fix.

---

## Technical Findings

### Finding 1: Steer-Queued Messages Can Be Silently Dropped

**File:** `apps/backend/src/swarm/codex-agent-runtime.ts` (lines 183–220, 537–555, 491–515)

When `sendMessage()` is called on a Codex runtime that has an active turn (`activeTurnId` is set), the message is queued as a steer:

```typescript
if (this.activeTurnId || this.startRequestPending) {
    this.queueSteer(deliveryId, message);
    await this.flushSteersIfPossible();
    return { acceptedMode: "steer" };  // ← Optimistic receipt
}
```

`flushSteersIfPossible()` tries to deliver via `turn/steer` RPC. However, if the turn completes (either naturally or due to a race) before the flush:

```typescript
// flushSteersIfPossible:
if (!this.threadId || !this.activeTurnId) {
    return;  // ← Orphaned steers remain in queuedSteers
}
```

When `turn/completed` arrives:

```typescript
case "turn/completed": {
    this.activeTurnId = undefined;  // ← Steers can no longer be flushed
    await this.updateStatus("idle");
    // ← NO check for remaining queuedSteers!
    // ← NO re-delivery mechanism!
}
```

**The message is accepted with `acceptedMode: "steer"` but never delivered.** It sits in `queuedSteers` until a new message arrives (which starts a new turn instead of flushing old steers) or the agent terminates (which drops all queued steers entirely).

### Finding 2: Error Notifications Go to Worker, Not Manager

**File:** `apps/backend/src/swarm/swarm-manager.ts` (lines 2197–2242)

When `recoverFromTurnFailure` fires (e.g., steer delivery RPC fails because the turn already completed server-side), the error flows through:

```
codex-agent-runtime.recoverFromTurnFailure()
  → reportRuntimeError()
  → callbacks.onRuntimeError()
  → swarm-manager.handleRuntimeError()
  → emitConversationMessage({ agentId: workerAgentId, ... })
```

The error message is emitted to the **worker's** conversation feed, not the manager's. The manager agent never receives an in-context notification that the review message was dropped. The manager's model context still shows a successful `send_message_to_agent` tool result:

```
"Queued message for gm-planner-2. deliveryId=..., mode=steer"
```

### Finding 3: `handleRuntimeAgentEnd` Is a No-Op

**File:** `apps/backend/src/swarm/swarm-manager.ts` (line 2293)

```typescript
private async handleRuntimeAgentEnd(_agentId: string): Promise<void> {
    // No-op: managers now receive all inbound messages with sourceContext metadata
    // and decide whether to respond without pending-reply bookkeeping.
}
```

When a worker completes its turn:
1. The runtime transitions to `idle`
2. `onAgentEnd` callback fires → reaches `handleRuntimeAgentEnd` → does nothing
3. The manager agent is **not notified** that the worker finished

This means the manager relies entirely on workers proactively calling `send_message_to_agent` back. If a worker's turn completes without doing so (e.g., the message was a steer that was dropped, or the worker errored silently), the manager has no way to know the task stalled.

### Finding 4: Compound Shell Wrappers Create Indefinite Streaming Locks

Workers that run compound bash commands like:

```bash
nohup npm run api:dev > /tmp/log.log 2>&1 &
sleep 5
curl http://localhost:3001/health
npm run web:build
kill %1
wait
```

…cause the worker's turn to remain `streaming` for the entire duration. Evidence:
- `/tmp/gm-main-api-for-webbuild.log`: API started at 04:44:53, SIGINT at 04:47:50 (3 min)
- `/tmp/gm-main-api.log`: `EADDRINUSE` from overlapping API starts
- `/tmp/gm-real-data-runtime.log`: EADDRINUSE from concurrent worktree port conflicts

During this streaming period, all incoming messages are queued as steers. If the bash command eventually fails (port conflict, timeout), the steers may be dropped via `recoverFromTurnFailure`.

### Finding 5: Nohup Launches Leave Agents Falsely Streaming

**Evidence:** `/tmp/gm-stream-ui-web3.log` shows Next.js ready at `localhost:3111`. The `gm-ui-live` agent launched this server but stayed in `streaming` status because the nohup/background bash invocation hadn't returned. The service was live and reachable, but the agent appeared busy to the manager. `gm-ui-live` didn't go idle until 07:00:12, despite the server being ready much earlier.

### Finding 6: Claude Code Runtime Has Similar But Subtler Delivery Risks

**File:** `apps/backend/src/swarm/claude-code-runtime.ts` (lines 147–161)

The Claude Code (Anthropic) runtime uses an input-stream model:

```typescript
if (this.isProcessing) {
    this.pendingDeliveries.push({...});
    this.pushInput(sdkMessage);  // ← Adds to async iterable queue
    return { acceptedMode: "steer" };
}
```

If `this.inputDone` is true (stream has ended), `pushInput` silently returns without enqueueing:

```typescript
private pushInput(message: SDKUserMessage): void {
    if (this.inputDone) {
        return;  // ← Silent drop
    }
    ...
}
```

This can happen if the stream exits unexpectedly between the `isProcessing` check and the `pushInput` call.

---

## Why the Manager/User Experience Diverged from Actual State

The divergence occurs at multiple levels:

### Level 1: Optimistic Receipts
`send_message_to_agent` returns `"Queued message for X. mode=steer"` immediately. The manager sees this as confirmation of delivery. But `mode=steer` means "queued into an in-flight turn" — it does not mean "the agent will process this message." The manager has no way to distinguish "steer accepted and will be processed" from "steer queued but turn is about to complete and steers will be orphaned."

### Level 2: No Completion Callbacks
`handleRuntimeAgentEnd` is a no-op. The manager doesn't receive automatic "agent X finished its turn" notifications. It must rely on explicit `send_message_to_agent` callbacks from workers, or periodically poll `list_agents` for status changes.

### Level 3: Error Isolation
Runtime errors (including dropped steers) are emitted to the worker's conversation feed, not the manager's model context. The manager agent literally cannot see that a message was dropped unless it checks the worker's conversation feed — which it has no mechanism to do.

### Level 4: Status Lag
Workers can appear `streaming` long after their meaningful work is complete (nohup/background processes). The manager sees `streaming` and assumes work is in progress, when in reality the worker is stuck waiting for a bash command to return.

---

## Agent Summary Table

| Agent ID | Role | Model | Created | Terminated/Idle | Context% | Notes |
|----------|------|-------|---------|-----------------|----------|-------|
| jerry | manager | codex gpt-5.4 | 03-08 21:44 | streaming | 43.5% | Orchestrator |
| gm-planner | worker | codex gpt-5.4 | 03-09 00:36 | terminated immediately | — | Replaced by gm-planner-2 |
| gm-planner-2 | worker/reviewer | codex gpt-5.4 | 03-09 00:36 | idle 21:40 | 78.4% | Primary reviewer; multiple pickup gaps |
| gm-merger | worker/merger | codex gpt-5.4 | 03-09 00:45 | idle 21:40 | 71.3% | Merger archetype |
| gm-api-docs | worker/reviewer | codex gpt-5.4 | 03-09 00:46 | idle 21:45 | 62.6% | Fallback reviewer |
| gm-listener-research | worker | codex gpt-5.4 | 03-09 00:46 | idle 00:51 | 12.3% | Short research task |
| gm-backend-foundation | worker | codex gpt-5.4 | 03-09 00:46 | terminated 05:10 | — | Hung on compound shell; replaced |
| gm-ui-dashboard | worker | opus | 03-09 02:03 | terminated 04:07 | — | UI dashboard foundation |
| gm-ui-live | worker | opus | 03-09 03:36 | idle 07:00 | 93.4% | Near context exhaustion; nohup streaming quirk |
| gm-backend-resume | worker | codex gpt-5.4 | 03-09 05:19 | idle 21:32 | 61.2% | Resumed from gm-backend-foundation's worktree |
| gm-systemd-launch | worker | opus | 03-09 05:42 | idle 07:09 | 41.0% | Systemd unit deployment |

---

## Likely Root Causes

### Primary: Steer Message Loss on Turn Completion (Race Condition)

**Severity: Critical**

When a manager sends a message to a worker with an active turn, the message is queued as a steer with an optimistic receipt. If the turn completes before the steer is flushed, the message is orphaned. No error is raised to the caller. The `turn/completed` handler does not check for or re-deliver remaining queued steers.

### Secondary: No Manager-Facing Turn-Completion Feedback

**Severity: High**

`handleRuntimeAgentEnd` is a no-op. The manager agent has no automatic mechanism to know when a worker finishes. Combined with the steer-loss issue, the manager can send a review task, get a receipt, and wait indefinitely for a response that will never come.

### Contributing: Error Events Misrouted

**Severity: Medium**

When steer delivery fails (e.g., `turn/steer` RPC error because the turn already ended server-side), `recoverFromTurnFailure` reports the error to the worker's conversation feed. The manager agent never sees this error in its model context.

### Contributing: Compound Shell Process-Control Patterns

**Severity: Medium**

Workers using background/poll/build/kill patterns in single bash invocations create extended streaming locks and port conflicts. These prevent incoming messages from being processed and create cascading resource issues (orphaned processes, EADDRINUSE).

---

## Recommendations / Next Actions

### 1. Re-deliver orphaned steers on turn completion (Critical)

In `codex-agent-runtime.ts`, when `turn/completed` fires and `queuedSteers` is non-empty, start a new turn with the oldest queued message instead of going idle:

```typescript
case "turn/completed": {
    this.activeTurnId = undefined;
    // ... existing cleanup ...
    if (this.queuedSteers.length > 0) {
        const next = this.queuedSteers.shift()!;
        await this.startTurn(next.message);  // Start new turn with orphaned steer
        return;
    }
    await this.updateStatus("idle");
    // ...
}
```

### 2. Notify the manager when a worker turn completes (High)

Implement `handleRuntimeAgentEnd` to send an automatic status message to the worker's owning manager:

```typescript
private async handleRuntimeAgentEnd(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") return;
    const managerId = descriptor.managerId;
    if (!managerId) return;
    // Send a lightweight turn-completed signal to the manager
    await this.sendMessage(agentId, managerId,
        `SYSTEM: Worker ${agentId} turn completed, now idle.`, "auto");
}
```

### 3. Route delivery-failure errors to the manager context (Medium)

In `handleRuntimeError`, when a worker experiences a delivery failure with `droppedPendingCount > 0`, also emit the error to the manager's conversation feed:

```typescript
if (descriptor.role === "worker" && descriptor.managerId) {
    this.emitConversationMessage({
        type: "conversation_message",
        agentId: descriptor.managerId,  // Manager's context
        role: "system",
        text: `⚠️ Worker ${agentId}: ${text}`,
        timestamp: this.now(),
        source: "system"
    });
}
```

### 4. Add delivery acknowledgment to send_message_to_agent (Medium)

Consider adding a `delivery: "confirmed"` mode that blocks until the message is actually consumed by the worker's turn (i.e., the steer RPC succeeds or a new turn starts), rather than returning an optimistic receipt.

### 5. Add stale-streaming detection (Low–Medium)

Add a watchdog that detects workers stuck in `streaming` for longer than a configurable threshold (e.g., 15 minutes) without any session events, and either alerts the manager or automatically interrupts.

### 6. Discourage compound shell wrappers in worker system prompts (Low)

Add guidance in the worker system prompt:
> Avoid compound shell commands that background long-lived servers, poll health, run tasks, then kill/wait. Use separate small bash invocations for each step. Use `nohup ... &` only when explicitly needed, and call `send_message_to_agent` immediately after to report the server is up.

---

## Appendix: Evidence References

### A. Agent Descriptors
- Source: `/root/.middleman/swarm/agents.json`
- Contains creation times, update times, status, model, and context usage for all 11 agents

### B. Manager Memory
- Source: `/root/.middleman/memory/jerry.md`
- Contains explicit learnings about reviewer-gap workarounds, compound shell avoidance, and nohup streaming quirks

### C. Git History
- Source: `git -C /root/ondo-gm-tracker log --all`
- 29 commits across 16 branches, 6 merge commits
- Branch creation/merge timing correlates with agent activity windows

### D. Process Logs
- Source: `/tmp/gm-*.log` (41 log files)
- Shows API start/stop cycles, port conflicts, SIGTERM sequences
- Timestamps correlate with compound shell hang periods

### E. Systemd Service Timestamps
- Source: `systemctl show ondo-gm-*.service --property=ExecMainStartTimestamp`
- All three services started at 2026-03-09 21:30:07 UTC (consistent with ops-hardening deployment)

### F. Source Code Analysis
- `apps/backend/src/swarm/codex-agent-runtime.ts`: Steer queue lifecycle, turn completion handler, recovery logic
- `apps/backend/src/swarm/claude-code-runtime.ts`: Input stream delivery, pushInput silent-drop path
- `apps/backend/src/swarm/swarm-manager.ts`: sendMessage flow, handleRuntimeError, handleRuntimeAgentEnd (no-op)
- `apps/backend/src/swarm/swarm-tools.ts`: send_message_to_agent tool definition, optimistic receipt format
- `apps/backend/src/swarm/agent-state-machine.ts`: Status transition rules

### G. Session Files (sizes only — not inspected per constraints)
- `jerry.jsonl`: 18MB / 9583 lines (heavy orchestration)
- `gm-planner-2.jsonl`: 7.6MB / 3168 lines (heavy reviewer usage)
- `gm-backend-foundation.jsonl`: 7.4MB / 3257 lines (terminated worker, compound shell issues)
- `gm-merger.jsonl`: 4.6MB / 2597 lines
- `gm-api-docs.jsonl`: 2.8MB / 1227 lines (fallback reviewer)

---

## Confidence Levels

| Finding | Confidence | Basis |
|---------|-----------|-------|
| Steer-queued message loss race condition | **High** | Direct code analysis; race is structurally present in codex-agent-runtime.ts |
| handleRuntimeAgentEnd no-op causing feedback gap | **High** | Direct code reading; comment in source confirms intentional no-op |
| Error routing to worker instead of manager | **High** | Direct code analysis of handleRuntimeError |
| Compound shell hang causing gm-backend-foundation termination | **High** | Corroborated by /tmp logs, EADDRINUSE errors, and agent termination time |
| Nohup streaming-state quirk | **High** | Corroborated by /tmp/gm-stream-ui-web3.log, agent status, and manager memory |
| Review gap #1 (feat/ui-live-data) | **Medium** | Inferred from branch timeline gaps; no direct transcript evidence |
| Review gap #3 (feat/ops-hardening) | **Medium–High** | 8-minute gap between worker finish and reviewer update; fallback reviewer engaged 5 min later |
| Claude Code runtime silent-drop path | **Medium** | Code shows the path exists; no direct evidence it was triggered in this session |

---

*Report generated by investigation worker `middleman-issue-investigator` at 2026-03-10T04:18 UTC.*

# Spec: Self-heal session resume after process death (dispatch-miss rehydration)

Status: ready-for-agent
Repo: paseo-plugin-zcode-provider (fork, branch `local-patches`)
Source analysis: 2026-10-28 session — kill-tree test + provider/persistence code audit.

## Problem Statement

Sessions whose process tree dies (killed by a memory reaper, lost in a crash, or orphaned after an abnormal daemon restart) can be read forever but never continued: sending a new message fails with `SESSION_NOT_FOUND`. The user kills idle session trees to reclaim ~10 GB of RAM, so every killed chat silently downgrades to read-only. This is worse than it sounds because the ingredients for recovery all exist — the provider already writes a logical→native session mapping to disk, and the host protocol already supports resuming a native session in a fresh runtime — the dispatch path just never falls back to them.

## Solution

When a prompt arrives for a session the running provider instance does not know, the provider heals itself instead of failing: it loads a small durable index record (written at session creation) that ties the public session id to the persisted handle and the minimal config needed to re-open, re-runs the existing resume flow against the host, registers the session, and proceeds with the turn. If the native session is genuinely gone, the provider opens a brand-new native session, clearly surfaces that prior context was lost, and lets the work continue. Result: any chat stays continuable no matter how many times its processes were killed; read-only chats stop being a thing.

## User Stories

1. As a Paseo user, I want to continue a chat after its process tree was killed, so that killing sessions for RAM never costs me a conversation.
2. As a Paseo user, I want killed sessions to resume with their full prior context, so that I don't have to re-explain a task.
3. As a Paseo user, I want a clear signal when a resumed session could not recover its native context, so that I know the model is starting fresh rather than silently losing the thread.
4. As a Paseo user, I want the daily memory-reaper to be safe to run aggressively, so that I don't have to curate a keep-list of "chats I might still continue".
5. As a Paseo user, I want sessions that were properly closed to stay closed, so that self-heal never resurrects conversations I deliberately ended.
6. As a Paseo user, I want self-heal to fail with today's clear error when recovery is impossible (e.g. the workspace directory is gone), so that broken states stay visible instead of being masked.
7. As a schedule-fired one-shot agent, I want my session to remain continuable after my processes are reaped, so that a follow-up "continue that" message works like it does for any other chat.
8. As the fork maintainer, I want self-heal to reuse the same open/attach code path as normal creation, so that there is exactly one resume mechanism to maintain.
9. As the fork maintainer, I want the index record written with the same atomic-write discipline as the existing persistence records, so that a crash mid-write can never corrupt the store.
10. As the fork maintainer, I want index records cleaned up on normal session close, so that the state directory does not grow without bound.
11. As the fork maintainer, I want self-heal serialized with turn execution, so that a rehydration racing a steer or a second prompt cannot interleave events.
12. As the fork maintainer, I want the feature confined to the provider plugin, so that no Paseo core or client changes are required and the patch survives upstream rebates cleanly-ish.
13. As a future implementer, I want the rehydration path observable in tests through the same fake-host seam as every other provider behavior, so that I can verify the feature without a real ZCode runtime.
14. As a Paseo user on iOS, I want dispatch to a dead session to succeed transparently, so that resuming from the phone behaves the same as from the desktop.
15. As the fork maintainer, I want a warning event (not a silent fallback) when the fresh-session fallback triggers, so that support questions like "why did it forget everything" are answerable from the timeline.

## Implementation Decisions

- **Two-layer persistence stays as-is.** The existing logical→native record store is untouched; this feature adds a sibling index namespace in the same state root, keyed by the public (Paseo-side) session id.
- **Index record contract** (decided in the 2026-10-28 analysis session; shape shown for precision):

  ```ts
  // sessions state root / index / <publicSessionId>.json
  {
    version: 1,
    handle: ProviderPersistence,  // the same handle returned to Paseo (logical or native kind)
    config: {
      cwd: string,                // resolved workspace path
      env?: Record<string,string>,// needed to spawn the same runtime on heal (state dir is 0700/0600)
      model?: string,             // encoded model selection, if one was requested
      thinkingOption?: string,
      mcpServers: …               // as passed at creation
    }
  }
  ```

  Written after a session is successfully opened (best-effort: a failed write is logged and the open proceeds — the session then stays un-resumable after death, the pre-feature behavior); re-pointed at the replacement handle after a fresh-session fallback; deleted only when the session is closed through the provider (provider/connection teardown keeps it). No mode or settings are stored (ADR-0014 — a resumed native session carries its own).
- **One open path.** The body of session creation (resolve handle → initialize workspace → `resumeSession`/`createSession` on the host → build the session object → apply initial config) is extracted into an internal helper used by both normal creation and self-heal, and the post-attach wiring (native event subscription, pending-permission emission, skill discovery) is shared helpers used by both paths. Self-heal must go through the `resumeSession` variant whenever the handle resolves to a native id.
- **Self-heal hook point.** The dispatch entry that currently throws on a registry miss becomes: registry miss → load index → (no index) throw as today → (index) rebuild via the helper, register, continue the turn. The throw-on-missing-index behavior is preserved verbatim so properly closed sessions keep today's semantics.
- **Atomic + durable writes.** Index writes reuse the store's existing temp-file → rename → fsync discipline and its 0o600/0o700 permission scheme. The index lives outside the plugin checkout, so reinstalling the plugin never erases it.
- **Fresh-session fallback, narrowly triggered.** Only a resume rejection (the resume RPC failing, surfaced as a resume-class error) may trigger the fallback: the provider opens a new native session, re-points the index at it, emits a distinguishable provider event (a session-level notice naming the lost session) *before the turn completes*, and completes the pending turn without prior context. Spawn, workspace, and transport errors surface unchanged — never masked by a fallback. Workspace validity is checked before any host spawn so the historical workspace error wins.
- **Concurrency.** A rebuilding session registers into the same per-session queue discipline as normal sessions before any turn events flow, so rehydration cannot interleave with steering or duplicate `prompt_result` emission.
- **Unchanged paths.** Daemon-start revival (Paseo re-calling creation with the stored handle) is untouched; properly closed sessions error as today; workspace/config validation errors surface unchanged.
- **Naming.** The feature is "self-heal resume"; the index records are "resume index records" (distinct from the existing "persistence records").

## Testing Decisions

- **Seam: one, and it already exists.** All tests run through the provider connection against the fake host (the established provider fixture), asserting on emitted provider events and observed host RPC calls. No real ZCode, no filesystem tricks beyond the fixture's temp state root. Two provider connections can share one fixture's store to simulate "fresh adapter, same disk state".
- **What makes a good test here:** external behavior only — which host RPCs were called with which ids, which events were emitted and in what order, how many prompt/turn results appear. No assertions on internal maps or helper call counts.
- **Required cases:**
  1. Creating a session writes a resume index record carrying the handle and config; closing the session removes it.
  2. Dispatching to an unknown session id on a *second* connection (fresh instance, same store) triggers a host `resumeSession` with the original native id, registers the session, and completes exactly one turn with exactly one admission result for the healed prompt — the core user story.
  3. Resume rejected by the host → host sees a fresh `createSession`, a warning event is emitted before the turn completes, the turn completes, and the index has been re-pointed at the replacement handle.
  4. Dispatch to a session with no index record (properly closed) → fails today-style.
  5. Index pointing at a workspace that no longer resolves → the workspace error surfaces as a dispatch rejection with no host RPCs attempted (no resume, no fallback create).
- **Prior art:** the existing provider behavior tests — fixture + `wait(predicate)` + host-call assertions + the turn-completion helper — are the pattern to extend.

## Out of Scope

- Fixing the ZCode runtime's own session persistence (the `resumeSession` capability is consumed, not built).
- The upstream 0.4.3 rebase (separate pending decision; this patch sits on `local-patches` and slightly grows the two already-expected conflict files).
- The idle-session memory reaper / launchd job (separate effort; this spec is what makes it safe to be aggressive).
- Any Paseo core, client, or iOS changes.
- Making archived (soft-deleted) Paseo sessions resumable.
- Recovering model context after the fresh-session fallback — the transcript stays viewable in Paseo, but the new native session starts without prior history. Surfacing that honestly is in scope; preventing it is not.

## Further Notes

- Real-world smoke after merge (manual, once): create a throwaway Paseo agent, kill its process tree, send a follow-up prompt, expect a real reply with context intact — mirrors the 2026-10-28 kill-tree experiment that documented the bug.
- The 2026-10-28 evidence chain this spec rests on: the index/persistence layer already survives process death (199 records on disk, test record intact); the host `resumeSession` RPC works in a fresh runtime (daemon-start revival; a 10-08 chat continued across restarts on 10-26); the only gap is dispatch not falling back.
- Fork-only feature: upstream has the same gap and no issue filed. If the rebase lands later, this patch is part of the fork's identity (like goal-mode), not something to upstream quietly.
- Governance: the fresh-session fallback amends ADR-0005 (which mandated hard-fail on native-session loss) for the dispatch-miss path only — recorded in the fork's ADR-0020.

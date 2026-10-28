---
number: 20
title: Dispatch-miss self-heal resume with a fresh-session fallback
status: accepted
date: 2026-10-28
links:
  - target: 5
    kind: amends
  - target: 14
    kind: conforms
---

# Dispatch-miss self-heal resume with a fresh-session fallback

## Context and Problem Statement

ADR-0005 mandates that resume fails on native-session loss and that the provider never hides a failure by switching to a different conversation. That rule was written for the session-open path, where Paseo drives the resume and a hard failure is the honest answer.

Since then, sessions are also killed _outside_ the open path: idle session trees are reaped to reclaim memory, and an adapter process can die at any moment. When a prompt is then dispatched to a session the fresh provider instance has no in-memory state for, the dispatch fails with `SESSION_NOT_FOUND` even though the persistence store (ADR-0005) and the host `resumeSession` RPC both work. Killed chats permanently downgrade to read-only, which makes aggressive memory reaping dangerous and punishes the user for normal process hygiene.

## Decision Drivers

- Killed sessions must stay continuable; memory hygiene must not cost conversations.
- ADR-0014: never infer or separately store setting values.
- ADR-0005's integrity rules (atomic writes, handle versioning, fail on corruption/workspace mismatch) stay in force.
- A visible, honest signal whenever prior context could not be restored.

## Considered Options

1. **Keep failing the dispatch** (status quo) — simplest, but every killed chat is dead forever.
2. **Self-heal, fail hard when restore is impossible** — covers most kills, but a truly lost native session still bricks the chat.
3. **Self-heal with a fresh-session fallback + visible warning** — chat always continues; context loss is explicit, never silent.

## Decision Outcome

Option 3. On dispatch to an unknown session id, the provider consults a resume index (written at open, distinct from the ADR-0005 handle store) and rebuilds the session through the normal resume flow.

- This **amends ADR-0005** for the dispatch-miss path only: when the runtime rejects the resume, the provider opens a fresh native session, points the index at it, emits a `session.notice` warning naming the lost native session, and lets the turn proceed. ADR-0005's hard-fail rule still governs the session-open path.
- Only a resume rejection (`SESSION_NOT_FOUND` from the resume RPC) triggers the fallback. Spawn, workspace, and transport errors surface unchanged.
- The index stores the minimal re-open config: cwd, env (needed to spawn the same runtime; the state directory is 0700/0600), model, thinking option, MCP servers. It deliberately stores **no mode or settings** (ADR-0014) — a resumed native session carries its own.
- The index write at open is best-effort: failure is logged and the open proceeds (the session simply stays un-resumable after death, as before this ADR).
- The index is deleted only on a user-initiated session close. Connection/provider teardown keeps it — a killed process must stay recoverable.

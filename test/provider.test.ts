import { afterEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { providerFixture } from "./provider-fixture.js";
import { completeTurn, FakeBridge, snapshot } from "./fake-host.js";
import { AdapterError } from "../server/errors.js";
import { createZCodeProvider, CAPABILITIES } from "../server/provider.js";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { GoalState } from "../server/vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await providerFixture();
  cleanups.push(f.close);
  return f;
}
it("accepts only after ACK even if rows and terminal state arrive first", async () => {
  const f = await fixture();
  await f.open();
  f.host.afterAdmit = () => completeTurn(f.host);
  await f.prompt();
  await f.wait((e) => e.type === "session.turn" && e.state === "completed");
  const ack = f.events.findIndex((e) => e.type === "session.prompt_result");
  expect(
    f.events.findIndex(
      (e) => e.type === "session.turn" && e.state === "started",
    ),
  ).toBeGreaterThan(ack);
  expect(
    f.events.filter((e) => e.type === "session.prompt_result"),
  ).toHaveLength(1);
  expect(
    f.events.filter(
      (e) => e.type === "session.turn" && e.state === "completed",
    ),
  ).toHaveLength(1);
});
it("hides the shared Browser and Computer Use tool from every input", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  expect(await f.prompt("m2", "guide")).toMatchObject({
    result: { type: "steer" },
  });
  await completeTurn(f.host);
  const payloads = f.host.calls
    .filter((c) => c.params?.envelope?.type === "sendText")
    .map((c) => c.params.envelope.payload);
  expect(payloads).toHaveLength(2);
  for (const payload of payloads)
    expect(payload.toolDisallowlist).toEqual(["mcp__node_repl__js"]);
});
it("aggregates guide input and emits complete row snapshots with stable IDs", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await f.host.append({
    ...f.host.rowBase(),
    kind: "assistantText",
    text: "a",
    state: "streaming",
  });
  const row = f.host.state.rows.window.at(-1)!;
  await f.host.deltas([
    { op: "row.delta", rowId: row.rowId, path: "text", append: "b" },
  ]);
  const second = await f.prompt("m2", "guide");
  expect(second).toMatchObject({ result: { type: "steer" } });
  await completeTurn(f.host);
  const items = f.events.filter(
    (e) => e.type === "timeline.item" && e.item.type === "assistant_message",
  );
  expect(
    items
      .slice(0, 2)
      .map((e) => (e.type === "timeline.item" ? e.item : undefined)),
  ).toMatchObject([
    { id: `zcode:row:${row.rowId}`, text: "a" },
    { id: `zcode:row:${row.rowId}`, text: "ab" },
  ]);
  expect(
    f.events.filter(
      (e) => e.type === "session.turn" && e.state === "completed",
    ),
  ).toHaveLength(1);
});
it("preserves native row timestamps during replay, live updates and resume", async () => {
  const f = await fixture();
  const createdAt = Date.parse("2026-01-02T03:04:05.000Z");
  const original = {
    ...f.host.rowBase(),
    createdAt,
    kind: "assistantText" as const,
    text: "Earlier response",
    state: "complete" as const,
  };
  await f.host.append(original);
  await f.open();
  const replay = await f.wait(
    (e) =>
      e.type === "timeline.item" && e.item.id === `zcode:row:${original.rowId}`,
  );
  expect(replay).toMatchObject({
    timestamp: new Date(createdAt).toISOString(),
  });
  await f.prompt();
  const live = {
    ...f.host.rowBase(),
    createdAt: createdAt + 60_000,
    kind: "assistantText" as const,
    text: "Live",
    state: "streaming" as const,
  };
  await f.host.append(live);
  await f.host.deltas([
    { op: "row.delta", rowId: live.rowId, path: "text", append: " response" },
  ]);
  const updates = f.events.filter(
    (e) =>
      e.type === "timeline.item" && e.item.id === `zcode:row:${live.rowId}`,
  );
  expect(updates).toHaveLength(2);
  for (const event of updates)
    expect(event).toMatchObject({
      timestamp: new Date(live.createdAt).toISOString(),
    });
  await completeTurn(f.host);
  const persisted = f.events.find((e) => e.type === "session.opened");
  if (persisted?.type !== "session.opened")
    throw new Error("Missing persistence");
  await f.send({
    type: "session.close",
    sessionId: "public",
    requestId: "close",
  });
  f.events.length = 0;
  await f.open({}, persisted.persistence);
  expect(
    await f.wait(
      (e) =>
        e.type === "timeline.item" && e.item.id === `zcode:row:${live.rowId}`,
    ),
  ).toMatchObject({ timestamp: new Date(live.createdAt).toISOString() });
});
it("does not infer queue consumption from disappearance", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  f.host.deferConsumption = true;
  await f.prompt("m2", "queued");
  const item = f.host.state.queue.items[0]!;
  await f.host.deltas([
    { op: "state.updated", patch: { queue: { autoDrain: true, items: [] } } },
  ]);
  await f.host.finish();
  expect(
    f.events.some((e) => e.type === "session.turn" && e.state === "completed"),
  ).toBe(false);
  await f.host.consume(item.sourceCommandId, "queued");
  await completeTurn(f.host);
  expect(
    f.events.filter(
      (e) => e.type === "session.turn" && e.state === "completed",
    ),
  ).toHaveLength(1);
});
it("never resends an input with an unknown admission result", async () => {
  const f = await fixture();
  await f.open();
  f.host.failAdmission = "unknown";
  expect(await f.prompt()).toMatchObject({ result: { type: "failed" } });
  expect(
    f.host.calls.filter((c) => c.params?.envelope?.type === "sendText"),
  ).toHaveLength(1);
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(true);
});
it("rejects failed admission without destroying a running turn", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  f.host.failAdmission = "rejected";
  expect(await f.prompt("m2")).toMatchObject({ result: { type: "failed" } });
  expect(f.host.closed).toBe(false);
  await completeTurn(f.host);
});
it("targets stop by foreground execution ID and cancels queued input", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  const target = f.host.activeProductTurn;
  f.host.deferConsumption = true;
  await f.prompt("m2");
  await f.send({
    type: "session.interrupt",
    sessionId: "public",
    requestId: "stop",
  });
  await f.wait((e) => e.type === "request.completed" && e.requestId === "stop");
  expect(
    f.host.calls.find((c) => c.params?.envelope?.type === "stop")?.params
      .envelope.payload,
  ).toEqual({ expectedForegroundExecutionId: target });
  expect(f.host.state.queue).toMatchObject({ autoDrain: false, items: [] });
  expect(
    f.events.filter((e) => e.type === "session.turn" && e.state === "canceled"),
  ).toHaveLength(1);
  f.host.deferConsumption = false;
  await f.prompt("m3", "resume");
  expect(f.host.state.queue.autoDrain).toBe(true);
  await completeTurn(f.host);
});
it("records the native ID before sending and rejects write failure", async () => {
  const f = await fixture();
  await f.open();
  vi.spyOn(f.store, "save").mockRejectedValue(
    new AdapterError("PERSISTENCE_WRITE_FAILED", "test"),
  );
  expect(await f.prompt()).toMatchObject({
    result: { type: "failed", error: { code: "PERSISTENCE_WRITE_FAILED" } },
  });
  expect(
    f.host.calls.some((c) => c.params?.envelope?.type === "sendText"),
  ).toBe(false);
});
it.each([1, 2])(
  "rejects old persistence version %s without creating a replacement",
  async (version) => {
    const f = await fixture();
    expect(
      await f.open(
        {},
        { version, data: { kind: "native", sessionId: "old", cwd: f.cwd } },
      ),
    ).toMatchObject({
      type: "request.failed",
      error: { code: "PERSISTENCE_VERSION_UNSUPPORTED" },
    });
    expect(f.host.calls).toEqual([]);
  },
);
it.each([
  {
    override: { persist: false },
    message: "The verified ZCode host requires persistent sessions",
  },
  // Schema failures carry no plugin-authored reason, so the text stays generic.
  {
    override: { providerOptions: { unknown: true } },
    message: "ZCode operation failed (INVALID_CONFIGURATION)",
  },
])(
  "explicitly rejects unsupported configuration with its reason",
  async ({ override, message }) => {
    const f = await fixture();
    expect(await f.open(override)).toMatchObject({
      type: "request.failed",
      error: { code: "INVALID_CONFIGURATION", message },
    });
    expect(f.host.calls).toEqual([]);
  },
);
it("folds a client system prompt into the first message only", async () => {
  const f = await fixture();
  await f.open({ systemPrompt: "custom instructions" });
  await f.prompt();
  await completeTurn(f.host);
  await f.prompt("m2", "second");
  await completeTurn(f.host);
  const texts = f.host.calls
    .filter((c) => c.params?.envelope?.type === "sendText")
    .map((c) => c.params.envelope.payload.text);
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain("custom instructions");
  expect(texts[0]).toContain("hello");
  expect(texts[1]).toBe("second");
});
it("keeps a system prompt pending until the first real message", async () => {
  const f = await fixture();
  await f.open({ systemPrompt: "custom instructions" });
  expect(await f.prompt("plan", "/plan")).toMatchObject({
    result: { type: "completed" },
  });
  await f.prompt();
  await completeTurn(f.host);
  const texts = f.host.calls
    .filter((c) => c.params?.envelope?.type === "sendText")
    .map((c) => c.params.envelope.payload.text);
  expect(texts).toHaveLength(1);
  expect(texts[0]).toContain("custom instructions");
  expect(texts[0]).toContain("hello");
});
it("does not fold a system prompt into a resumed native session", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await completeTurn(f.host);
  const index = (await f.store.loadIndex("public"))!;
  await f.connection.close();
  const peer = await freshPeer(f);
  peer.host.afterAdmit = () => completeTurn(peer.host);
  await peer.connection.send({
    type: "session.open",
    sessionId: "public",
    requestId: "open",
    config: { ...f.config, systemPrompt: "custom instructions" },
    history: "replay",
    persistence: { version: 3, data: index.handle },
  });
  await peer.wait(
    (e) => e.type === "session.ready" || e.type === "request.failed",
  );
  await peer.prompt("m2");
  await peer.wait((e) => e.type === "session.turn" && e.state === "completed");
  const texts = peer.host.calls
    .filter((c) => c.params?.envelope?.type === "sendText")
    .map((c) => c.params.envelope.payload.text);
  expect(texts).toHaveLength(1);
  expect(texts[0]).not.toContain("custom instructions");
});
it("reports cumulative usage without adding repeated snapshots", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await completeTurn(f.host);
  await f.host.emitSnapshot();
  await f.host.emitSnapshot();
  expect(
    f.events.filter(
      (e) => e.type === "session.usage" && e.usage.inputTokens === 20,
    ),
  ).toHaveLength(1);
});
it("announces background continuation without fabricating user input", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await completeTurn(f.host);
  const before = f.events.filter(
    (e) => e.type === "timeline.item" && e.item.type === "user_message",
  ).length;
  f.host.activeProductTurn = "background-1";
  await f.host.append({
    ...f.host.rowBase(),
    kind: "turnHeader",
    origin: "backgroundResult",
    state: "running",
    startedAt: 2,
  });
  await f.host.finish();
  expect(
    f.events.filter((e) => e.type === "session.turn" && e.state === "started"),
  ).toHaveLength(2);
  expect(
    f.events.filter(
      (e) => e.type === "timeline.item" && e.item.type === "user_message",
    ),
  ).toHaveLength(before);
});
it("cancels unconsumed queue input after a native failure and finishes once", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  f.host.deferConsumption = true;
  await f.prompt("second");
  await f.host.finish("failed");
  await f.wait((e) => e.type === "session.turn" && e.state === "failed");
  expect(f.host.state.queue.items).toEqual([]);
  expect(
    f.events.filter((e) => e.type === "session.turn" && e.state === "failed"),
  ).toHaveLength(1);
});
it("renders configuration markers without inventing a product turn", async () => {
  const f = await fixture();
  await f.open();
  const { productTurnId, turnId, ...base } = f.host.rowBase();
  await f.host.append({
    ...base,
    turnId: "",
    kind: "timelineMarker",
    marker: {
      type: "modelChange",
      toProvider: "provider",
      toModel: "model",
      toThought: "high",
    },
  });
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
  expect(
    f.events.some(
      (e) => e.type === "timeline.item" && e.item.type === "notification",
    ),
  ).toBe(true);
});
it("lists native sessions using the current handle version", async () => {
  const f = await fixture();
  await f.send({ type: "sessions", requestId: "list", cwd: f.cwd });
  const result = await f.wait((e) => e.type === "sessions");
  expect(result).toMatchObject({
    sessions: [
      {
        persistence: {
          version: 3,
          data: { kind: "native", sessionId: "session-1" },
        },
      },
    ],
  });
});
it("completes /plan without creating a model turn or persisting a draft", async () => {
  const f = await fixture();
  await f.open();
  expect(await f.prompt("plan", "/plan")).toMatchObject({
    result: { type: "completed" },
  });
  expect(f.host.state.config.planEnabled).toBe(true);
  expect(f.events.some((e) => e.type === "session.turn")).toBe(false);
  expect(
    f.host.calls.some((c) => c.params?.envelope?.type === "sendText"),
  ).toBe(false);
});
it("answers native interactions once and ignores responses after their observed resolution", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  const interaction = {
    interactionId: "child-question",
    kind: "userInput" as const,
    anchorRowId: 1,
    createdAt: 1,
    payload: {
      kind: "userInput" as const,
      prompt: "Choose",
      freeText: true,
      questions: [
        {
          header: "Choice",
          question: "Select",
          options: [{ label: "One", value: "native-one" }],
        },
      ],
    },
  };
  await f.host.deltas([
    { op: "state.updated", patch: { pendingInteractions: [interaction] } },
  ]);
  await f.wait((e) => e.type === "session.permission");
  const answer = {
    type: "session.permission" as const,
    sessionId: "public",
    permissionId: interaction.interactionId,
    response: {
      behavior: "allow" as const,
      updatedInput: { answers: { Choice: "One" } },
    },
  };
  await f.send(answer);
  await f.wait((e) => e.type === "session.permission_resolved");
  await completeTurn(f.host);
  await f.prompt("next");
  await f.send(answer);
  expect(await f.prompt("after-late")).toMatchObject({
    result: { type: "steer" },
  });
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
  await completeTurn(f.host);
  await f.connection.close();
  const calls = f.host.calls.filter(
    (c) => c.params?.envelope?.type === "resolveInteraction",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.params.envelope.payload).toMatchObject({
    interactionId: "child-question",
    answer: {
      action: "accept",
      content: { answers: { Select: ["native-one"] } },
    },
  });
});
it("steers a typed message, which always asks to clear pending permissions", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await f.send({
    type: "session.prompt",
    sessionId: "public",
    prompt: {
      clientMessageId: "typed",
      input: { type: "message", content: [{ type: "text", text: "steer" }] },
      delivery: "steer",
      clearPendingPermissions: true,
    },
  });
  expect(
    await f.wait(
      (e) =>
        e.type === "session.prompt_result" && e.clientMessageId === "typed",
    ),
  ).toMatchObject({ result: { type: "steer" } });
  await completeTurn(f.host);
  expect(
    f.host.calls.some((c) => c.params?.envelope?.type === "resolveInteraction"),
  ).toBe(false);
});
it("declines interactions blocking a typed steer until ZCode reads it", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  const permission = (id: string) => ({
    interactionId: id,
    kind: "permission" as const,
    anchorRowId: 1,
    createdAt: 1,
    payload: {
      kind: "permission" as const,
      toolCallId: id,
      toolName: "Bash",
      summary: "run",
      detail: { command: "pwd" },
      options: [
        { optionId: "once", label: "Once", kind: "allowOnce" as const },
        { optionId: "deny", label: "Deny", kind: "deny" as const },
      ],
    },
  });
  const request = async (id: string) => {
    await f.host.deltas([
      {
        op: "state.updated",
        patch: {
          pendingInteractions: [
            ...f.host.state.pendingInteractions,
            permission(id),
          ],
        },
      },
    ]);
    await f.wait((e) => e.type === "session.permission" && e.request.id === id);
  };
  const resolutions = () =>
    f.host.calls
      .filter((c) => c.params?.envelope?.type === "resolveInteraction")
      .map((c) => c.params.envelope.payload);
  await request("blocking");
  f.host.deferConsumption = true;
  await f.send({
    type: "session.prompt",
    sessionId: "public",
    prompt: {
      clientMessageId: "typed",
      input: { type: "message", content: [{ type: "text", text: "steer" }] },
      delivery: "steer",
      clearPendingPermissions: true,
    },
  });
  expect(
    await f.wait(
      (e) =>
        e.type === "session.prompt_result" && e.clientMessageId === "typed",
    ),
  ).toMatchObject({ result: { type: "steer" } });
  await f.wait(
    (e) =>
      e.type === "session.permission_resolved" && e.permissionId === "blocking",
  );
  // A later tool of the same model step asks again before the steer is read.
  await request("later");
  await f.wait(
    (e) =>
      e.type === "session.permission_resolved" && e.permissionId === "later",
  );
  const steer = f.host.calls.findLast(
    (c) => c.params?.envelope?.type === "sendText",
  )!.params.envelope.commandId;
  await f.host.consume(steer, "steer", true);
  await request("after-read");
  await f.send({
    type: "session.permission",
    sessionId: "public",
    permissionId: "after-read",
    response: { behavior: "allow", selectedActionId: "once" },
  });
  await f.wait(
    (e) =>
      e.type === "session.permission_resolved" &&
      e.permissionId === "after-read",
  );
  expect(resolutions()).toEqual([
    { interactionId: "blocking", answer: { optionId: "deny" } },
    { interactionId: "later", answer: { optionId: "deny" } },
    { interactionId: "after-read", answer: { optionId: "once" } },
  ]);
  await completeTurn(f.host);
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
});
it("accepts Paseo's replacement prompt after a steer was not admitted", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  const input = {
    type: "message" as const,
    content: [{ type: "text" as const, text: "/review src" }],
  };
  await f.send({
    type: "session.prompt",
    sessionId: "public",
    prompt: { clientMessageId: "m2", input, delivery: "steer" },
  });
  expect(
    await f.wait(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "m2",
    ),
  ).toMatchObject({ result: { type: "failed" } });
  // Paseo interrupts and resends the unavailable steer with its clientMessageId.
  await f.send({
    type: "session.interrupt",
    sessionId: "public",
    requestId: "stop",
  });
  await f.wait((e) => e.type === "session.turn" && e.state === "canceled");
  f.events.length = 0;
  await f.send({
    type: "session.prompt",
    sessionId: "public",
    prompt: { clientMessageId: "m2", input, delivery: "auto" },
  });
  expect(
    await f.wait(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "m2",
    ),
  ).toMatchObject({ result: { type: "turn" } });
  await completeTurn(f.host);
});
it("offers guarded mode only on ZCode 3.15.1 and later", async () => {
  const f = await fixture();
  const modes = () =>
    (
      f.events.findLast((e) => e.type === "session.config") as Extract<
        (typeof f.events)[number],
        { type: "session.config" }
      >
    ).config.modes?.map((m) => m.id);
  const configure = async (requestId: string) => {
    await f.send({
      type: "session.configure",
      sessionId: "public",
      requestId,
      changes: { mode: "guarded" },
    });
    return f.wait(
      (e) =>
        (e.type === "request.completed" || e.type === "request.failed") &&
        e.requestId === requestId,
    );
  };
  await f.open();
  expect(modes()).toEqual(["build", "edit", "yolo"]);
  expect(await configure("old")).toMatchObject({
    type: "request.failed",
    error: { code: "INVALID_CONFIGURATION" },
  });
  expect(f.host.state.config.mode).toBe("build");

  f.host.diagnostic.appVersion = "3.16.2";
  expect(await configure("new")).toMatchObject({ type: "request.completed" });
  expect(f.host.state.config.mode).toBe("guarded");
  expect(modes()).toEqual(["build", "edit", "guarded", "yolo"]);
  expect(
    f.host.calls.find(
      (c) => c.params?.envelope?.type === "switchCollaborationMode",
    )?.params.envelope.payload,
  ).toEqual({ mode: "guarded" });
});

it("sends /goal pause as a CAS command and retries a stale ack at the runtime's revision", async () => {
  const f = await fixture();
  await f.open();
  const goal: GoalState = {
    targetId: "goal-1",
    objective: "keep the build green",
    summaryTitle: null,
    timeUsedSeconds: 3,
    activeRunStartedAtMs: null,
    status: "active",
    iteration: 1,
    verifications: [],
    iterations: [],
  };
  f.host.state.goal = goal;
  f.host.state.availability.pauseGoal = { allowed: true };
  await f.host.emitSnapshot();
  const request = f.host.request.bind(f.host);
  let stale = true;
  f.host.request = async (method, params, schema) => {
    if (
      method === "sendConversationCommandV4" &&
      params?.envelope?.type === "pauseGoal"
    ) {
      // The early return below skips FakeBridge.request's own recording.
      f.host.calls.push({ method, params });
      if (stale) {
        stale = false;
        return schema.parse({
          commandId: params.envelope.commandId,
          status: "stale",
          reasonCode: "revisionMoved",
          revisionAtDecision: 7,
        });
      }
      f.host.state.goal = { ...goal, status: "paused" };
      await f.host.emitSnapshot();
      return schema.parse({
        commandId: params.envelope.commandId,
        status: "accepted",
        revisionAtDecision: 7,
      });
    }
    return request(method, params, schema);
  };
  await f.prompt("pause", "/goal pause");
  const envelopes = f.host.calls
    .filter(
      (c) =>
        c.method === "sendConversationCommandV4" &&
        c.params?.envelope?.type === "pauseGoal",
    )
    .map((c) => c.params.envelope);
  expect(envelopes).toHaveLength(2);
  expect(envelopes[0].baseRevision).toBe(0);
  expect(envelopes[1].baseRevision).toBe(7);
  expect(
    f.events.some(
      (e) =>
        e.type === "timeline.item" &&
        (e.item as { text?: string }).text === "Official goal paused.",
    ),
  ).toBe(true);
});
it("sends /goal resume as a CAS command and retries a stale ack at the runtime's revision", async () => {
  const f = await fixture();
  await f.open();
  const goal: GoalState = {
    targetId: "goal-1",
    objective: "keep the build green",
    summaryTitle: null,
    timeUsedSeconds: 30,
    activeRunStartedAtMs: null,
    status: "paused",
    iteration: 1,
    verifications: [],
    iterations: [],
  };
  f.host.state.goal = goal;
  f.host.state.availability.resumeGoal = { allowed: true };
  await f.host.emitSnapshot();
  const request = f.host.request.bind(f.host);
  let stale = true;
  f.host.request = async (method, params, schema) => {
    if (
      method === "sendConversationCommandV4" &&
      params?.envelope?.type === "resumeGoal"
    ) {
      // The early return below skips FakeBridge.request's own recording.
      f.host.calls.push({ method, params });
      if (stale) {
        stale = false;
        return schema.parse({
          commandId: params.envelope.commandId,
          status: "stale",
          reasonCode: "revisionMoved",
          revisionAtDecision: 9,
        });
      }
      f.host.state.goal = { ...goal, status: "active" };
      await f.host.emitSnapshot();
      return schema.parse({
        commandId: params.envelope.commandId,
        status: "accepted",
        revisionAtDecision: 9,
      });
    }
    return request(method, params, schema);
  };
  await f.prompt("resume", "/goal resume");
  const envelopes = f.host.calls
    .filter(
      (c) =>
        c.method === "sendConversationCommandV4" &&
        c.params?.envelope?.type === "resumeGoal",
    )
    .map((c) => c.params.envelope);
  expect(envelopes).toHaveLength(2);
  expect(envelopes[0].baseRevision).toBe(0);
  expect(envelopes[1].baseRevision).toBe(9);
  expect(
    f.events.some(
      (e) =>
        e.type === "timeline.item" &&
        (e.item as { text?: string }).text ===
          "Official goal resumed — the loop continues below.",
    ),
  ).toBe(true);
});

// ── Self-heal resume after process death ─────────────────────────────────

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function freshPeer(f: Fixture) {
  const host = new FakeBridge(snapshot(f.cwd));
  const connection = await createZCodeProvider(
    async () => host,
    f.store,
  ).connect({ versions: [1], capabilities: CAPABILITIES });
  cleanups.push(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((e) => events.push(e));
  const wait = async (predicate: (e: ProviderEvent) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const event = events.find(predicate);
      if (event) return event;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(
      `Missing peer event; ${events.map((e) => e.type).join(", ")}`,
    );
  };
  const prompt = (id: string) =>
    connection.send({
      type: "session.prompt",
      sessionId: "public",
      prompt: {
        clientMessageId: id,
        input: { type: "message", content: [{ type: "text", text: "again" }] },
        delivery: "auto",
      },
    });
  return { host, connection, events, wait, prompt };
}

it("writes a resume index on open and removes it on close", async () => {
  const f = await fixture();
  await f.open();
  expect(await f.store.loadIndex("public")).toMatchObject({
    version: 1,
    handle: { kind: "logical" },
    config: { cwd: f.cwd },
  });
  await f.send({
    type: "session.close",
    sessionId: "public",
    requestId: "close",
  });
  await f.wait((e) => e.type === "session.closed");
  expect(await f.store.loadIndex("public")).toBeUndefined();
});

it("keeps the resume index when the connection dies", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await f.connection.close();
  expect(await f.store.loadIndex("public")).toBeDefined();
});

it("self-heals a killed session on the next prompt", async () => {
  const f = await fixture();
  await f.open();
  f.host.afterAdmit = () => completeTurn(f.host);
  await f.prompt();
  await f.connection.close();
  const peer = await freshPeer(f);
  peer.host.afterAdmit = () => completeTurn(peer.host);
  await peer.prompt("m2");
  await peer.wait((e) => e.type === "session.turn" && e.state === "completed");
  expect(
    peer.host.calls.some(
      (c) =>
        c.method === "resumeSession" && c.params?.sessionId === "session-1",
    ),
  ).toBe(true);
  expect(
    peer.events.some(
      (e) =>
        e.type === "session.prompt_result" &&
        e.clientMessageId === "m2" &&
        e.result.type === "failed",
    ),
  ).toBe(false);
  // Exactly one admission result for the healed prompt — no duplicates.
  expect(
    peer.events.filter(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "m2",
    ),
  ).toHaveLength(1);
});

it("falls back to a fresh session with a warning when resume is refused", async () => {
  const f = await fixture();
  await f.open();
  f.host.afterAdmit = () => completeTurn(f.host);
  await f.prompt();
  const original = await f.store.loadIndex("public");
  await f.connection.close();
  const peer = await freshPeer(f);
  peer.host.failResume = true;
  peer.host.afterAdmit = () => completeTurn(peer.host);
  await peer.prompt("m2");
  await peer.wait((e) => e.type === "session.turn" && e.state === "completed");
  expect(peer.host.calls.some((c) => c.method === "resumeSession")).toBe(true);
  expect(peer.host.calls.some((c) => c.method === "createSession")).toBe(true);
  const noticeAt = peer.events.findIndex((e) => e.type === "session.notice");
  const turnAt = peer.events.findIndex(
    (e) => e.type === "session.turn" && e.state === "completed",
  );
  expect(noticeAt).toBeGreaterThanOrEqual(0);
  expect(noticeAt).toBeLessThan(turnAt);
  const notice = peer.events[noticeAt];
  expect(notice).toMatchObject({
    sessionId: "public",
    notice: { severity: "warning" },
  });
  if (notice?.type === "session.notice")
    expect(notice.notice.description).toContain("session-1");
  // The index must point at the replacement conversation so a second
  // process death resumes the fallback session instead of falling back again.
  const healed = await f.store.loadIndex("public");
  expect(healed?.handle).toMatchObject({ kind: "logical" });
  expect(healed?.handle).not.toEqual(original?.handle);
  expect(
    peer.events.some(
      (e) =>
        e.type === "session.prompt_result" &&
        e.clientMessageId === "m2" &&
        e.result.type === "failed",
    ),
  ).toBe(false);
});

it("still fails for sessions without a resume index", async () => {
  const f = await fixture();
  const peer = await freshPeer(f);
  await expect(peer.prompt("m2")).rejects.toThrow(/Unknown ZCode session/);
  expect(peer.host.calls.some((c) => c.method === "resumeSession")).toBe(false);
});

it("surfaces workspace errors instead of healing when the workspace is gone", async () => {
  const f = await fixture();
  await f.open();
  f.host.afterAdmit = () => completeTurn(f.host);
  await f.prompt();
  await f.connection.close();
  const record = await f.store.loadIndex("public");
  await f.store.saveIndex("public", {
    version: 1,
    handle: record!.handle,
    config: { ...record!.config, cwd: join(f.cwd, "vanished") },
  });
  const peer = await freshPeer(f);
  await expect(peer.prompt("m2")).rejects.toThrow();
  expect(
    peer.host.calls.some(
      (c) => c.method === "resumeSession" || c.method === "createSession",
    ),
  ).toBe(false);
});

import { describe, expect, it } from "vitest";
import type {
  ConversationSnapshot,
  GoalState,
  SessionActionAvailability,
} from "../vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import {
  GoalModeAdapter,
  GoalModeUnavailableError,
  formatGoalStatus,
  goalStartPayload,
  projectGoalView,
  routeGoalCommand,
  type GoalRoutingAction,
  type GoalRoutingContext,
} from "./adapter.js";

const availability = (
  pause: boolean,
  resume: boolean,
): SessionActionAvailability =>
  ({
    fork: { allowed: true },
    compact: { allowed: true },
    switchModelConfig: { allowed: true },
    setFollowupMode: { allowed: true },
    queueEdit: { allowed: true },
    sendQueuedNow: { allowed: true },
    pauseGoal: pause
      ? { allowed: true }
      : { allowed: false, reasonCode: "goal.busy" },
    resumeGoal: resume
      ? { allowed: true }
      : { allowed: false, reasonCode: "goal.notPaused" },
  }) as SessionActionAvailability;

const goalState = (over: Partial<GoalState> = {}): GoalState =>
  ({
    targetId: "t1",
    objective: "Ship the export button",
    summaryTitle: null,
    timeUsedSeconds: 754,
    activeRunStartedAtMs: null,
    status: "active",
    iteration: 3,
    verifications: [
      {
        iteration: 2,
        outcome: "notSatisfied",
        at: 1000,
        anchorRowId: 42,
        reason: "button missing",
        nextAction: "add the button",
      },
      { iteration: 3, outcome: "pass", at: 2000, anchorRowId: 55 },
    ],
    iterations: [
      {
        iteration: 3,
        updatedAt: 2000,
        items: [
          { id: "i1", content: "add button", status: "completed" },
          { id: "i2", content: "wire click", status: "inProgress" },
          { id: "i3", content: "test", status: "pending" },
        ],
      },
    ],
    ...over,
  }) as GoalState;

const snapshotWith = (
  goal: GoalState | null,
  avail?: SessionActionAvailability,
): ConversationSnapshot =>
  ({ goal, ...(avail ? { availability: avail } : {}) }) as unknown as ConversationSnapshot;

describe("projectGoalView", () => {
  it("maps goal state and action availability onto the view", () => {
    const view = projectGoalView(
      snapshotWith(goalState(), availability(true, false)),
    )!;
    expect(view.objective).toBe("Ship the export button");
    expect(view.status).toBe("active");
    expect(view.iteration).toBe(3);
    expect(view.timeUsedSeconds).toBe(754);
    expect(view.planItems).toHaveLength(3);
    expect(view.planItems[0]).toEqual({
      id: "i1",
      content: "add button",
      status: "completed",
    });
    expect(view.verifications).toHaveLength(2);
    expect(view.verifications[1].outcome).toBe("pass");
    expect(view.canPause).toBe(true);
    expect(view.canResume).toBe(false);
  });

  it("returns null for a snapshot without a goal", () => {
    expect(projectGoalView(snapshotWith(null))).toBeNull();
    expect(projectGoalView(undefined)).toBeNull();
  });

  it("treats missing availability as not actionable", () => {
    const view = projectGoalView(snapshotWith(goalState()))!;
    expect(view.canPause).toBe(false);
    expect(view.canResume).toBe(false);
  });
});

describe("formatGoalStatus", () => {
  it("renders objective, status, iteration, plan items and verifications", () => {
    const text = formatGoalStatus(
      projectGoalView(snapshotWith(goalState(), availability(true, false)))!,
    );
    expect(text).toContain("Ship the export button");
    expect(text).toContain("active");
    expect(text).toContain("iteration 3");
    expect(text).toContain("12m34s");
    expect(text).toContain("Plan: 1/3 done");
    expect(text).toContain("[completed] add button");
    expect(text).toContain("[inProgress] wire click");
    expect(text).toContain("Verification #2: notSatisfied — button missing");
    expect(text).toContain("Verification #3: pass");
  });

  it("renders every status label and the no-verification case", () => {
    for (const status of [
      "active",
      "paused",
      "verifying",
      "verified",
      "notSatisfied",
      "failed",
    ] as const) {
      const text = formatGoalStatus(
        projectGoalView(
          snapshotWith(goalState({ status, verifications: [], iterations: [] })),
        )!,
      );
      expect(text).toContain(status === "notSatisfied" ? "not satisfied" : status);
      expect(text).toContain("No verifications yet");
    }
  });

  it("keeps only the latest three verifications", () => {
    const verifications = [1, 2, 3, 4, 5].map((iteration) => ({
      iteration,
      outcome: "pass" as const,
      at: iteration * 1000,
      anchorRowId: null,
    }));
    const text = formatGoalStatus(
      projectGoalView(snapshotWith(goalState({ verifications })))!,
    );
    expect(text).toContain("Verification #3");
    expect(text).toContain("Verification #5");
    expect(text).not.toContain("Verification #2");
  });
});

describe("goalStartPayload", () => {
  it("carries the objective and only the provided config fields", () => {
    expect(goalStartPayload("do it", {})).toEqual({ text: "do it" });
    expect(
      goalStartPayload("do it", {
        modelSelection: { provider: "p", model: "m" },
        planEnabled: true,
      }),
    ).toEqual({
      text: "do it",
      modelSelection: { provider: "p", model: "m" },
      planEnabled: true,
    });
  });
});

describe("routeGoalCommand", () => {
  const base = {
    officialGoal: null,
    officialUsable: true,
    driverRunning: false,
    driverStateSaved: false,
  };
  const official = (status: GoalState["status"]): GoalRoutingContext => ({
    ...base,
    officialGoal: {
      objective: "o",
      status,
      iteration: 1,
      planItems: [],
      verifications: [],
      timeUsedSeconds: 0,
      canPause: true,
      canResume: status === "paused",
    },
  });
  function expectKind(
    action: GoalRoutingAction,
    kind: GoalRoutingAction["kind"],
  ) {
    expect(action.kind).toBe(kind);
  }

  it("routes status by precedence: official, live driver, saved state, none", () => {
    expectKind(routeGoalCommand("status", official("active")), "official-status");
    expectKind(
      routeGoalCommand("status", { ...base, driverRunning: true }),
      "driver-status",
    );
    expectKind(
      routeGoalCommand("status", { ...base, driverStateSaved: true }),
      "driver-status",
    );
    const none = routeGoalCommand("status", base);
    expectKind(none, "note");
    expect(none.kind === "note" && none.message).toContain("No goal loop");
  });

  it("routes pause: official first, then driver, else a note", () => {
    expectKind(routeGoalCommand("pause", official("active")), "official-pause");
    expectKind(
      routeGoalCommand("pause", { ...base, driverRunning: true }),
      "driver-pause",
    );
    expectKind(routeGoalCommand("pause", base), "note");
  });

  it("routes resume: paused official, live driver, saved driver, notes otherwise", () => {
    expectKind(routeGoalCommand("resume", official("paused")), "official-resume");
    const activeOfficial = routeGoalCommand("resume", official("active"));
    expectKind(activeOfficial, "note");
    expect(activeOfficial.kind === "note" && activeOfficial.message).toContain(
      "active",
    );
    expectKind(
      routeGoalCommand("resume", { ...base, driverRunning: true }),
      "driver-resume",
    );
    expectKind(
      routeGoalCommand("resume", { ...base, driverStateSaved: true }),
      "driver-resume",
    );
    expectKind(routeGoalCommand("resume", base), "note");
  });

  it("routes stop: official first, then driver live or saved", () => {
    expectKind(routeGoalCommand("stop", official("active")), "official-stop");
    expectKind(
      routeGoalCommand("stop", { ...base, driverRunning: true }),
      "driver-stop",
    );
    expectKind(
      routeGoalCommand("stop", { ...base, driverStateSaved: true }),
      "driver-stop",
    );
  });

  it("refuses starts while any loop is active", () => {
    const busyDriver = routeGoalCommand("new objective", {
      ...base,
      driverRunning: true,
    });
    expectKind(busyDriver, "reject");
    const busyOfficial = routeGoalCommand("new objective", official("verifying"));
    expectKind(busyOfficial, "reject");
  });

  it("starts official when usable and falls back to the driver when blocked", () => {
    expectKind(routeGoalCommand("new objective", base), "start-official");
    expectKind(
      routeGoalCommand("new objective", { ...base, officialUsable: false }),
      "start-driver",
    );
  });

  it("treats any non-subcommand token — including the /auto alias path — as an objective", () => {
    // The label (/goal vs /auto) never reaches the router: free text is an
    // objective, matching the plugin loop's long-standing behavior.
    expectKind(routeGoalCommand("拆解 https://example.com", base), "start-official");
    expectKind(routeGoalCommand("staus", base), "start-official");
  });
});

describe("GoalModeAdapter", () => {
  it("isAvailable reflects goal field presence, not an active goal", () => {
    const adapter = new GoalModeAdapter({
      sendGoal: async () => ({ engaged: true }),
      sendAction: async () => ({}),
      snapshot: () => snapshotWith(null),
    });
    expect(adapter.isAvailable()).toBe(true);
    const absent = new GoalModeAdapter({
      sendGoal: async () => ({ engaged: true }),
      sendAction: async () => ({}),
      snapshot: () => undefined,
    });
    expect(absent.isAvailable()).toBe(false);
  });

  it("startObjective engages when accepted and the goal state appears", async () => {
    let started = false;
    const adapter = new GoalModeAdapter({
      sendGoal: async () => {
        started = true;
        return { engaged: true };
      },
      sendAction: async () => ({}),
      snapshot: () => (started ? snapshotWith(goalState()) : undefined),
    });
    await expect(
      adapter.startObjective("ship it", { planEnabled: false }),
    ).resolves.toBe("engaged");
  });

  it("startObjective reports refusal with the runtime's reason code", async () => {
    const adapter = new GoalModeAdapter({
      sendGoal: async () => ({ engaged: false, reasonCode: "goal.desktopOnly" }),
      sendAction: async () => ({}),
      snapshot: () => undefined,
    });
    await expect(adapter.startObjective("ship it", {})).rejects.toThrow(
      GoalModeUnavailableError,
    );
    await expect(adapter.startObjective("ship it", {})).rejects.toThrow(
      /goal\.desktopOnly/,
    );
  });

  it("startObjective refuses when the goal state never appears", async () => {
    const adapter = new GoalModeAdapter({
      sendGoal: async () => ({ engaged: true }),
      sendAction: async () => ({}),
      snapshot: () => undefined,
    });
    await expect(adapter.startObjective("ship it", {})).rejects.toThrow(
      /goalStateAbsent/,
    );
  }, 15_000);

  it("pause sends the command and verifies the state flip", async () => {
    const actions: string[] = [];
    let status: GoalState["status"] = "active";
    const adapter = new GoalModeAdapter({
      sendGoal: async () => ({ engaged: true }),
      sendAction: async (type) => {
        actions.push(type);
        status = "paused";
        return {};
      },
      snapshot: () =>
        snapshotWith(goalState({ status }), availability(true, true)),
    });
    expect(await adapter.pause()).toContain("paused");
    expect(actions).toEqual(["pauseGoal"]);
  });

  it("pause without availability does not send and surfaces the reason", async () => {
    const actions: string[] = [];
    const adapter = new GoalModeAdapter({
      sendGoal: async () => ({ engaged: true }),
      sendAction: async (type) => {
        actions.push(type);
        return {};
      },
      snapshot: () => snapshotWith(goalState(), availability(false, false)),
    });
    const line = await adapter.pause();
    expect(actions).toEqual([]);
    expect(line).toContain("goal.busy");
  });

  it("resume verifies the state flip even when the action ack is unreadable", async () => {
    let status: GoalState["status"] = "paused";
    const adapter = new GoalModeAdapter({
      sendGoal: async () => ({ engaged: true }),
      sendAction: async () => {
        status = "active";
        throw new Error("ack parse failed");
      },
      snapshot: () =>
        snapshotWith(goalState({ status }), availability(false, true)),
    });
    expect(await adapter.resume()).toContain("resumed");
  });

  it("resume reports the no-goal case without sending", async () => {
    const actions: string[] = [];
    const adapter = new GoalModeAdapter({
      sendGoal: async () => ({ engaged: true }),
      sendAction: async (type) => {
        actions.push(type);
        return {};
      },
      snapshot: () => snapshotWith(null),
    });
    expect(await adapter.resume()).toContain("No official goal");
    expect(actions).toEqual([]);
  });
});

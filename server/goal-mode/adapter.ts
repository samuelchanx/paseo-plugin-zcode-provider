import type {
  ConversationSnapshot,
  GoalState,
  SessionActionAvailability,
} from "../vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import { AdapterError } from "../errors.js";

/**
 * ZCode's official backend goal mode, over the V4 protocol the session already
 * speaks: the objective goes in as a sendGoalCommand admission, the runtime
 * drives its own decompose → iterate → verify loop (turns with a continuation
 * origin, goalSet/goalVerify markers), and the conversation snapshot carries
 * the authoritative goal state plus pause/resume action availability. This
 * module is the only place that knows those protocol facts.
 */

export type GoalView = {
  objective: string;
  status: GoalState["status"];
  iteration: number;
  planItems: { id: string; content: string; status: string }[];
  verifications: {
    iteration: number;
    outcome: string;
    at: number;
    reason?: string;
    nextAction?: string;
  }[];
  timeUsedSeconds: number;
  canPause: boolean;
  canResume: boolean;
  pauseGuard?: string;
  resumeGuard?: string;
};

export interface GoalStartConfig {
  modelSelection?: unknown;
  mode?: unknown;
  planEnabled?: boolean;
}

export function goalStartPayload(
  objective: string,
  config: GoalStartConfig,
): Record<string, unknown> {
  return {
    text: objective,
    ...(config.modelSelection !== undefined && {
      modelSelection: config.modelSelection,
    }),
    ...(config.mode !== undefined && { mode: config.mode }),
    ...(config.planEnabled !== undefined && {
      planEnabled: config.planEnabled,
    }),
  };
}

export function projectGoalView(
  snapshot: ConversationSnapshot | undefined,
): GoalView | null {
  const goal = snapshot?.goal;
  if (!goal) return null;
  const availability: SessionActionAvailability | undefined = snapshot
    .availability as SessionActionAvailability | undefined;
  const guard = (
    entry: SessionActionAvailability["pauseGoal"] | undefined,
  ): string | undefined =>
    entry && !entry.allowed && "reasonCode" in entry
      ? entry.reasonCode
      : undefined;
  return {
    objective: goal.objective,
    status: goal.status,
    iteration: goal.iteration,
    planItems: (goal.iterations.at(-1)?.items ?? []).map((item) => ({
      id: item.id,
      content: item.content,
      status: item.status,
    })),
    verifications: goal.verifications.map((v) => ({
      iteration: v.iteration,
      outcome: v.outcome,
      at: v.at,
      ...(v.reason !== undefined && { reason: v.reason }),
      ...(v.nextAction !== undefined && { nextAction: v.nextAction }),
    })),
    timeUsedSeconds: goal.timeUsedSeconds,
    canPause: availability?.pauseGoal?.allowed === true,
    canResume: availability?.resumeGoal?.allowed === true,
    ...(guard(availability?.pauseGoal) && {
      pauseGuard: guard(availability?.pauseGoal),
    }),
    ...(guard(availability?.resumeGoal) && {
      resumeGuard: guard(availability?.resumeGoal),
    }),
  };
}

const STATUS_LABEL: Record<GoalState["status"], string> = {
  active: "active",
  paused: "paused",
  verifying: "verifying",
  verified: "verified",
  notSatisfied: "not satisfied",
  failed: "failed",
};

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatGoalStatus(view: GoalView): string {
  const done = view.planItems.filter((i) => i.status === "completed").length;
  const lines = [
    `Official goal: ${view.objective}`,
    `Status: ${STATUS_LABEL[view.status]} (iteration ${view.iteration}) · ${formatDuration(view.timeUsedSeconds)} used`,
  ];
  if (view.planItems.length) {
    lines.push(`Plan: ${done}/${view.planItems.length} done`);
    for (const item of view.planItems)
      lines.push(`  · [${item.status}] ${item.content}`);
  } else lines.push("Plan: none yet");
  if (!view.verifications.length) lines.push("No verifications yet");
  else
    for (const v of view.verifications.slice(-3))
      lines.push(
        `Verification #${v.iteration}: ${v.outcome}${v.reason ? ` — ${v.reason}` : ""}${v.nextAction ? ` (next: ${v.nextAction})` : ""}`,
      );
  return lines.join("\n");
}

export interface GoalRoutingContext {
  officialGoal: GoalView | null;
  officialUsable: boolean;
  driverRunning: boolean;
  driverStateSaved: boolean;
}

export type GoalRoutingAction =
  | { kind: "official-status" }
  | { kind: "official-pause" }
  | { kind: "official-resume" }
  | { kind: "official-stop" }
  | { kind: "driver-status"; prior: boolean }
  | { kind: "driver-pause" }
  | { kind: "driver-resume" }
  | { kind: "driver-stop" }
  | { kind: "start-official" }
  | { kind: "start-driver" }
  | { kind: "reject"; reason: string }
  | { kind: "note"; message: string };

/** Control subcommand dispatch, pure so the interceptor wiring stays trivial. */
export function routeGoalCommand(
  sub: string,
  ctx: GoalRoutingContext,
): GoalRoutingAction {
  const { officialGoal, officialUsable, driverRunning, driverStateSaved } = ctx;
  switch (sub) {
    case "status":
    case "":
      if (officialGoal) return { kind: "official-status" };
      if (driverRunning) return { kind: "driver-status", prior: false };
      if (driverStateSaved) return { kind: "driver-status", prior: true };
      return { kind: "note", message: "No goal loop for this session." };
    case "pause":
      if (officialGoal) return { kind: "official-pause" };
      if (driverRunning) return { kind: "driver-pause" };
      return { kind: "note", message: "No running goal loop to pause." };
    case "resume":
      if (officialGoal) {
        if (officialGoal.status === "paused") return { kind: "official-resume" };
        return {
          kind: "note",
          message: `Official goal is ${STATUS_LABEL[officialGoal.status]} — resume not applicable.`,
        };
      }
      if (driverRunning) return { kind: "driver-resume" };
      if (driverStateSaved) return { kind: "driver-resume" };
      return { kind: "note", message: "No saved goal state to resume." };
    case "stop":
    case "clear":
      if (officialGoal) return { kind: "official-stop" };
      if (driverRunning || driverStateSaved) return { kind: "driver-stop" };
      return {
        kind: "note",
        message: "No running goal loop — saved state cleared.",
      };
    default:
      if (driverRunning)
        return { kind: "reject", reason: "A goal loop is already running." };
      if (
        officialGoal &&
        (officialGoal.status === "active" || officialGoal.status === "verifying")
      )
        return {
          kind: "reject",
          reason: `Official goal already ${STATUS_LABEL[officialGoal.status]} — stop or pause it first.`,
        };
      return officialUsable
        ? { kind: "start-official" }
        : { kind: "start-driver" };
  }
}

export class GoalModeUnavailableError extends AdapterError {
  readonly reasonCode: string;
  constructor(reasonCode: string) {
    super(
      "NATIVE_INPUT_REJECTED",
      `ZCode official goal mode is unavailable (${reasonCode || "refused"})`,
    );
    this.reasonCode = reasonCode || "refused";
  }
}

/**
 * The session-side operations the adapter needs; the provider wires the real
 * session. The goal start runs through the session's turn path (so Paseo's run
 * lifecycle tracks it) and reports plain engagement — the raw command ack is
 * the session layer's business and is not re-modelled here.
 */
export interface GoalStartResult {
  engaged: boolean;
  reasonCode?: string;
}

export interface GoalModeHost {
  sendGoal(payload: Record<string, unknown>): Promise<GoalStartResult>;
  sendAction(type: "pauseGoal" | "resumeGoal"): Promise<unknown>;
  snapshot(): ConversationSnapshot | undefined;
}

export class GoalModeAdapter {
  constructor(private readonly host: GoalModeHost) {}

  /** Official mode is present when the runtime projects a goal field at all. */
  isAvailable(): boolean {
    return this.host.snapshot()?.goal !== undefined;
  }

  state(): GoalView | null {
    return projectGoalView(this.host.snapshot());
  }

  /**
   * Polls the snapshot until the goal view satisfies the predicate. Pause,
   * resume and start are verified against the state, not the ack: the
   * runtime's goal/compact handler acks are not uniformly shaped, and the
   * authoritative outcome is always the projected goal state.
   */
  private async waitForGoal(
    pred: (view: GoalView | null) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pred(this.state())) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Starts the official loop. Throws GoalModeUnavailableError when the runtime
   * refuses the command or the goal state never appears — the caller falls
   * back to the plugin-side loop.
   */
  async startObjective(
    objective: string,
    config: GoalStartConfig,
  ): Promise<"engaged"> {
    const result = await this.host.sendGoal(goalStartPayload(objective, config));
    if (!result.engaged)
      throw new GoalModeUnavailableError(result.reasonCode ?? "refused");
    // An accepted command alone is not proof: confirm the runtime actually
    // projected a goal. Without this a silently-ignored command would count
    // as engagement.
    if (
      !(await this.waitForGoal((v) => v !== null, 8_000))
    )
      throw new GoalModeUnavailableError("goalStateAbsent");
    return "engaged";
  }

  async pause(): Promise<string> {
    const view = this.state();
    if (!view) return "No official goal on this session.";
    if (!view.canPause)
      return `Official goal cannot be paused right now${view.pauseGuard ? ` (${view.pauseGuard})` : " — the runtime is keeping the goal busy; use the stop button, which pauses the goal"}.`;
    try {
      await this.host.sendAction("pauseGoal");
    } catch {
      // Ack unreadable — the state decides below.
    }
    if (await this.waitForGoal((v) => v?.status === "paused", 5_000))
      return "Official goal paused.";
    return "Official goal pause did not take effect — check /goal status.";
  }

  async resume(): Promise<string> {
    const view = this.state();
    if (!view) return "No official goal on this session.";
    if (!view.canResume)
      return `Official goal cannot be resumed right now${view.resumeGuard ? ` (${view.resumeGuard})` : view.status !== "paused" ? ` (status: ${STATUS_LABEL[view.status]})` : ""}.`;
    try {
      await this.host.sendAction("resumeGoal");
    } catch {
      // Ack unreadable — the state decides below.
    }
    if (
      await this.waitForGoal(
        (v) => v?.status === "active" || v?.status === "verifying",
        5_000,
      )
    )
      return "Official goal resumed — the loop continues below.";
    return "Official goal resume did not take effect — check /goal status.";
  }
}

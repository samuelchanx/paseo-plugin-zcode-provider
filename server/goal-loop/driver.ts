/**
 * Goal-loop driver for the plugin (port of the zcode-acp bridge's ADR-0022
 * subsystem onto ZCodeSession primitives).
 *
 * Round shape, unchanged from the bridge: one decompose turn → one ticket per
 * dispatch turn with a worker VERDICT contract → on "met" an independent
 * verification turn (verdict FILE first, prose fallback) → stall and
 * round-budget pauses. Compaction/handoff and quota-wait are not ported (the
 * plugin has no compact control and no quota source): failed dispatch turns
 * retry with a bounded delay instead, then pause.
 *
 * The /goal prompt completes immediately and the loop runs detached from the
 * Paseo run lifecycle: rounds are real native turns that stream into the
 * timeline, and every boundary is announced as a notification item. (The
 * bridge's ACP version HELD the starting prompt open so clients would render
 * updates — impossible here: Paseo's run-start gate times a prompt out after
 * 60 s without a prompt_result.)
 */

import { readFileSync, unlinkSync } from "node:fs";

import { logger } from "../logger.js";
import type { ZCodeSession } from "../session.js";
import type { NativeSessionEvent } from "../session-types.js";
import {
  clearGoalState,
  readGoalState,
  verifyPath,
  writeGoalState,
  type GoalLoopState,
  type GoalTicket,
} from "./state.js";
import {
  decomposePrompt,
  dispatchPrompt,
  parseTickets,
  parseVerifyFile,
  parseVerifyReply,
  parseVerdict,
  strictVerifyPrompt,
  verifyPrompt,
} from "./templates.js";

/** Hard round budget before a pause (env: ZCODE_ACP_GOAL_MAX_TURNS). */
export function goalMaxTurns(): number {
  const n = Number(process.env.ZCODE_ACP_GOAL_MAX_TURNS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** Consecutive dispatch rounds with no tool activity before a stall pause. */
const STALL_ROUND_LIMIT = 3;
/** Failed verification turns tolerated per ticket before a pause. */
const VERIFY_ATTEMPT_LIMIT = 3;
/** How long a round waits for a busy session (user turns) before failing. */
const IDLE_WAIT_MS = 300_000;
/** Failed dispatch turns retried before the loop pauses. */
const TURN_RETRY_LIMIT = 2;
const RETRY_DELAY_MS = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type TurnOutcome =
  | { kind: "completed"; text: string; tools: number }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export interface GoalLoopHost {
  readonly cwd: string;
  readonly nativeSessionId: string;
  runTurn(prompt: string): Promise<TurnOutcome>;
  announce(message: string): void;
}

/** One goal-loop turn on the native session: idle-wait → send → collect. */
export async function runDriverTurn(
  native: ZCodeSession,
  prompt: string,
): Promise<TurnOutcome> {
  const idleDeadline = Date.now() + IDLE_WAIT_MS;
  while (native.hasActiveTurn()) {
    if (Date.now() > idleDeadline)
      return { kind: "failed", message: "session busy for over 5 minutes" };
    await sleep(250);
  }
  const events: NativeSessionEvent[] = [];
  const unsubscribe = native.subscribe((e) => events.push(e));
  try {
    const { turnId } = await native.startTurn(prompt);
    for (;;) {
      const fail = events.find(
        (e): e is Extract<NativeSessionEvent, { type: "turn_failed" | "runtime_failed" }> =>
          e.type === "runtime_failed",
      );
      if (fail) return { kind: "failed", message: fail.error };
      const terminal = events.find(
        (e) =>
          (e.type === "turn_completed" ||
            e.type === "turn_canceled" ||
            e.type === "turn_failed") &&
          e.turnId === turnId,
      );
      if (terminal) {
        if (terminal.type === "turn_canceled") return { kind: "cancelled" };
        if (terminal.type === "turn_failed")
          return { kind: "failed", message: terminal.error };
        break;
      }
      await sleep(200);
    }
    let text = "";
    let tools = 0;
    for (const e of events) {
      if (e.type !== "timeline" || e.turnId !== turnId) continue;
      if (e.item.type === "assistant_message") text += e.item.text;
      else if (e.item.type === "tool_call") tools++;
    }
    return { kind: "completed", text, tools };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  } finally {
    unsubscribe();
  }
}

export class GoalLoopDriver {
  private state: GoalLoopState;
  private pauseFlag = false;
  private stopFlag = false;
  private runId = 0;

  private constructor(
    private readonly host: GoalLoopHost,
    state: GoalLoopState,
  ) {
    this.state = state;
  }

  /** True while the loop is live (between start and a terminal status). */
  get running(): boolean {
    return this.state.status === "running";
  }

  /**
   * Start (or resume) the loop. Resuming adopts the persisted state (round
   * count, tickets); a fresh start decomposes the objective into tickets
   * first.
   */
  static start(
    host: GoalLoopHost,
    objective: string,
    opts: { resume?: boolean } = {},
  ): GoalLoopDriver {
    const prior = opts.resume
      ? readGoalState(host.cwd, host.nativeSessionId)
      : null;
    const state: GoalLoopState = prior ?? {
      objective,
      status: "running",
      rounds: 0,
      tickets: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.status = "running";
    if (!opts.resume) state.objective = objective;
    const driver = new GoalLoopDriver(host, state);
    const myRun = ++driver.runId;
    void driver.run(myRun).catch((e) =>
      logger.log(
        "warn",
        `goal-loop: driver crashed (${e instanceof Error ? e.message : String(e)})`,
      ),
    );
    return driver;
  }

  /** Pause at the next round boundary (the in-flight round keeps running). */
  pause(): void {
    this.pauseFlag = true;
  }

  /** Clear pending pause/stop flags (/goal resume before the boundary). */
  resume(): void {
    this.pauseFlag = false;
    this.stopFlag = false;
  }

  /** Stop at the next boundary and clear persisted state. */
  stop(): void {
    this.stopFlag = true;
  }

  /** One-line status for /goal status. */
  statusText(): string {
    return statusTextOf(this.state);
  }

  private persist(): void {
    writeGoalState(this.host.cwd, this.host.nativeSessionId, this.state);
  }

  private async endLoop(
    status: GoalLoopState["status"],
    reason: string,
    note?: string,
  ): Promise<void> {
    this.state.status = status;
    this.state.endedReason = reason;
    this.persist();
    if (status === "stopped")
      clearGoalState(this.host.cwd, this.host.nativeSessionId);
    this.host.announce(note ?? `⏸️ Goal loop ${status}: ${reason}`);
    logger.log("info", `goal-loop: ${this.host.nativeSessionId.slice(0, 8)} → ${status} (${reason})`);
  }

  private async run(myRun: number): Promise<void> {
    try {
      await this.runRounds(myRun);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.log("warn", `goal-loop: round machinery failed — pausing loop (${msg})`);
      if (this.runId !== myRun) return;
      try {
        await this.endLoop("paused-crash", msg);
      } catch (e2) {
        logger.log(
          "warn",
          `goal-loop: crash recovery failed (${e2 instanceof Error ? e2.message : String(e2)})`,
        );
      }
    }
  }

  private async runRounds(myRun: number): Promise<void> {
    const alive = (): boolean => this.runId === myRun;

    // Round 0 (uncounted): decompose the objective into tickets — unless
    // resuming with a ticket list already on record.
    if (this.state.tickets.length === 0) {
      this.host.announce(`🎯 Goal set: ${this.state.objective}`);
      const res = await this.host.runTurn(decomposePrompt(this.state.objective));
      if (!alive()) return;
      if (res.kind === "cancelled")
        return void (await this.endLoop("paused", "cancelled"));
      if (res.kind === "failed")
        return void (await this.endLoop(
          "paused-crash",
          `decompose failed: ${res.message}`,
        ));
      const parsed = parseTickets(res.text);
      this.state.tickets = (
        parsed ?? [{ title: this.state.objective, acceptance: this.state.objective }]
      ).map((t, i) => ({
        id: `t${i + 1}`,
        title: t.title,
        acceptance: t.acceptance,
        status: "pending" as const,
      }));
      this.persist();
    } else {
      this.host.announce(
        `▶️ Goal resumed at round ${this.state.rounds} (${this.state.tickets.length} tickets on record)`,
      );
    }

    let stallCount = 0;
    while (alive()) {
      if (this.stopFlag)
        return void (await this.endLoop("stopped", "/goal stop", "🛑 Goal loop stopped."));
      if (this.pauseFlag)
        return void (await this.endLoop("paused", "/goal pause"));

      const ticket = this.state.tickets.find(
        (t) => t.status === "pending" || t.status === "in_progress",
      );
      if (!ticket)
        return void (await this.endLoop(
          "complete",
          "all tickets done",
          `✅ Goal complete after ${this.state.rounds} rounds.`,
        ));
      ticket.status = "in_progress";

      if (this.state.rounds >= goalMaxTurns())
        return void (await this.endLoop(
          "paused-budget",
          `round budget ${goalMaxTurns()}`,
          `⏸️ Round budget ${goalMaxTurns()} reached — pausing (/goal resume continues).`,
        ));

      const outcome = await this.runDispatchRound(myRun, ticket);
      if (!alive()) return;
      if (outcome.cancelled) {
        ticket.status = "pending";
        this.persist();
        return void (await this.endLoop("paused", "cancelled"));
      }
      this.state.rounds++;

      // Stall detection: rounds with zero tool activity accumulate to a pause.
      stallCount = outcome.tools > 0 ? 0 : stallCount + 1;

      const verdict = parseVerdict(outcome.text);
      if (verdict?.kind === "impossible")
        return void (await this.endLoop(
          "impossible",
          verdict.why ?? "reported impossible",
          `⛔ Goal marked impossible: ${verdict.why ?? "no reason given"}`,
        ));

      if (verdict?.kind === "met") {
        const v = await this.verifyTicket(myRun, ticket);
        if (!alive()) return;
        if (v === "cancelled") {
          ticket.status = "pending";
          this.persist();
          return void (await this.endLoop("paused", "cancelled"));
        }
        if (v === null) {
          ticket.status = "pending";
          this.persist();
          return void (await this.endLoop(
            "paused",
            "verification unreadable",
            `⚠️ Verification for “${ticket.title}” produced no readable verdict — pausing.`,
          ));
        }
        if (v.pass) {
          ticket.status = "done";
          ticket.feedback = undefined;
          ticket.verifyAttempts = undefined;
        } else {
          ticket.feedback = v.reason ?? "verification failed";
          ticket.verifyAttempts = (ticket.verifyAttempts ?? 0) + 1;
          this.host.announce(
            `❌ Verify failed (${ticket.verifyAttempts}/${VERIFY_ATTEMPT_LIMIT}): ${ticket.title} — ${ticket.feedback}`,
          );
          if (ticket.verifyAttempts >= VERIFY_ATTEMPT_LIMIT)
            return void (await this.endLoop(
              "paused",
              `verification keeps failing for “${ticket.title}”`,
              `⏸️ Verification failed ${VERIFY_ATTEMPT_LIMIT}× for “${ticket.title}” — pausing for a human.`,
            ));
        }
      }

      this.persist();

      if (stallCount >= STALL_ROUND_LIMIT)
        return void (await this.endLoop(
          "paused-stall",
          "no tool activity",
          `⏸️ Paused after ${STALL_ROUND_LIMIT} rounds with no tool activity.`,
        ));

      this.host.announce(
        `🔁 Round ${this.state.rounds}/${goalMaxTurns()} — ${ticket.title}: ${
          ticket.status === "done" ? "done ✓" : "in progress"
        }`,
      );
    }
  }

  /** One dispatch turn with bounded retry on failed (not cancelled) turns. */
  private async runDispatchRound(
    myRun: number,
    ticket: GoalTicket,
  ): Promise<{ cancelled: true } | { cancelled: false; text: string; tools: number }> {
    const index = this.state.tickets.indexOf(ticket) + 1;
    for (let attempt = 0; ; attempt++) {
      const res = await this.host.runTurn(
        dispatchPrompt({
          objective: this.state.objective,
          ticket,
          ticketIndex: index,
          ticketCount: this.state.tickets.length,
        }),
      );
      if (this.runId !== myRun) return { cancelled: true };
      if (res.kind === "completed")
        return { cancelled: false, text: res.text, tools: res.tools };
      if (res.kind === "cancelled") return { cancelled: true };
      if (attempt >= TURN_RETRY_LIMIT)
        throw new Error(`dispatch failed: ${res.message}`);
      this.host.announce(
        `⚠️ Round turn failed (${res.message}) — retry ${attempt + 1}/${TURN_RETRY_LIMIT}`,
      );
      await sleep(RETRY_DELAY_MS);
      if (this.runId !== myRun || this.stopFlag || this.pauseFlag)
        return { cancelled: true };
    }
  }

  /**
   * Independent verification turn for a "met" verdict. Returns the parsed
   * verdict, null when unreadable (after the strict retry), or "cancelled".
   */
  private async verifyTicket(
    myRun: number,
    ticket: GoalTicket,
  ): Promise<{ pass: boolean; reason?: string } | null | "cancelled"> {
    const vPath = verifyPath(this.host.cwd, this.host.nativeSessionId);
    // Stale verdict from an earlier round must not be read as this one's.
    try {
      unlinkSync(vPath);
    } catch {
      /* absent — fine */
    }
    const readVerify = (): { pass: boolean; reason?: string } | null => {
      try {
        return parseVerifyFile(readFileSync(vPath, "utf8"));
      } catch {
        return null;
      }
    };
    let res = await this.host.runTurn(verifyPrompt(ticket, vPath));
    if (this.runId !== myRun) return "cancelled";
    if (res.kind === "cancelled") return "cancelled";
    if (res.kind === "failed") return null;
    let v = readVerify() ?? parseVerifyReply(res.text);
    if (!v) {
      res = await this.host.runTurn(strictVerifyPrompt(ticket, vPath));
      if (this.runId !== myRun) return "cancelled";
      if (res.kind === "cancelled") return "cancelled";
      if (res.kind === "failed") return null;
      v = readVerify() ?? parseVerifyReply(res.text);
    }
    return v;
  }
}

/** One-line status from a (live or persisted) state. */
export function statusTextOf(s: GoalLoopState): string {
  const done = s.tickets.filter((t) => t.status === "done").length;
  const current = s.tickets.find(
    (t) => t.status === "in_progress" || t.status === "pending",
  );
  const parts = [
    `goal ${s.status}`,
    `round ${s.rounds}/${goalMaxTurns()}`,
    `tickets ${done}/${s.tickets.length}`,
  ];
  if (current) parts.push(`current: ${current.title}`);
  if (s.endedReason && s.status !== "running") parts.push(`(${s.endedReason})`);
  return parts.join(" · ");
}

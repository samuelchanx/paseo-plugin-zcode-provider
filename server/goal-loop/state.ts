/**
 * Goal-loop persistent state (port of the zcode-acp bridge's ADR-0022 state
 * layer onto the plugin's session layout).
 *
 * Artifacts live under `<workspace>/.zcode/scratch/goals/<nativeSessionId>/`
 * keyed by the native ZCode session id (stable across Paseo restarts, unlike
 * Paseo session ids). Rich context (progress, next steps) is NOT stored here
 * by design — it lives in the model-written artifacts; this file only holds
 * what the DRIVER needs to resume: objective, round count, ticket checklist,
 * and the parked user text across a pause.
 *
 * Writes are temp-file + rename (one writer per session loop).
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { logger } from "../logger.js";

export type GoalTicketStatus = "pending" | "in_progress" | "done" | "blocked";

export interface GoalTicket {
  id: string;
  title: string;
  /** How to verify the ticket is done (rendered into dispatch + verify prompts). */
  acceptance: string;
  status: GoalTicketStatus;
  /** Last verification failure feedback (feeds the next dispatch round). */
  feedback?: string;
  /** Failed verification turns so far — bounded pauses beat infinite ping-pong. */
  verifyAttempts?: number;
}

export type GoalLoopStatus =
  | "running"
  | "paused"
  | "paused-budget"
  | "paused-stall"
  | "paused-crash"
  | "complete"
  | "impossible"
  | "stopped";

export interface GoalLoopState {
  objective: string;
  status: GoalLoopStatus;
  /** Completed dispatch rounds (verification/decompose turns excluded). */
  rounds: number;
  tickets: GoalTicket[];
  /** User text preserved across a pause, merged into the next dispatch. */
  parkedText?: string;
  createdAt: number;
  updatedAt: number;
  /** Final reason when the loop reached a terminal status. */
  endedReason?: string;
}

/** Directory holding a session's goal artifacts. */
export function goalDir(projectRoot: string, nativeSessionId: string): string {
  return path.join(projectRoot, ".zcode", "scratch", "goals", nativeSessionId);
}

export function statePath(projectRoot: string, nativeSessionId: string): string {
  return path.join(goalDir(projectRoot, nativeSessionId), "state.json");
}

/** Verification result file (model-written, read by the driver). */
export function verifyPath(projectRoot: string, nativeSessionId: string): string {
  return path.join(goalDir(projectRoot, nativeSessionId), "verify.txt");
}

/** Read a session's goal state; null when none exists or it is unreadable. */
export function readGoalState(
  projectRoot: string,
  nativeSessionId: string,
): GoalLoopState | null {
  try {
    const raw = JSON.parse(
      readFileSync(statePath(projectRoot, nativeSessionId), "utf8"),
    );
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof raw.objective !== "string" ||
      !Array.isArray(raw.tickets)
    ) {
      // Corrupt/hand-edited state reads as absent — a malformed tickets list
      // would otherwise throw inside the driver's round loop.
      return null;
    }
    return raw as GoalLoopState;
  } catch {
    return null;
  }
}

/** Atomically persist the goal state (temp file + rename). */
export function writeGoalState(
  projectRoot: string,
  nativeSessionId: string,
  state: GoalLoopState,
): void {
  state.updatedAt = Date.now();
  const dir = goalDir(projectRoot, nativeSessionId);
  const target = statePath(projectRoot, nativeSessionId);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, target);
  } catch (e) {
    logger.log(
      "warn",
      `goal-loop: state write failed (${e instanceof Error ? e.message : String(e)}) — continuing`,
    );
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to sweep */
    }
  }
}

/** Best-effort removal on /goal stop (terminal states keep the record). */
export function clearGoalState(projectRoot: string, nativeSessionId: string): void {
  try {
    unlinkSync(statePath(projectRoot, nativeSessionId));
  } catch {
    /* absent — fine */
  }
}

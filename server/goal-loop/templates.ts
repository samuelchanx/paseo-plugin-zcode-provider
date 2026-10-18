/**
 * Prompt templates for the goal loop (port of the zcode-acp bridge's
 * ADR-0022 templates, minus the handoff/compaction pair — the plugin has no
 * compact control, so rounds run on the session's native context).
 *
 * Frozen copies of the Matt Pocock workflow skill conventions (to-tickets
 * ticket shape, dispatch/VERDICT contracts). Do not read live skills at
 * runtime — user-editable skills must not change loop behavior.
 */

import type { GoalTicket } from "./state.js";

/** Decompose the objective into vertical-slice tickets (round 0, uncounted). */
export function decomposePrompt(objective: string): string {
  return [
    `# Objective`,
    objective,
    ``,
    `Decompose this objective into 1-5 vertical-slice tickets. A vertical slice`,
    `is a thin end-to-end increment that can be verified on its own — prefer`,
    `"smallest thing that works end to end" over horizontal layers.`,
    ``,
    `Reply with ONLY a fenced block, one ticket per line:`,
    "```",
    `- [title] | [how to verify it is done, concretely — commands to run, files to check]`,
    "```",
    ``,
    `No prose outside the block.`,
  ].join("\n");
}

/** Parse the decompose reply; null when no ticket lines parse out. */
export function parseTickets(
  reply: string,
): Array<{ title: string; acceptance: string }> | null {
  const clean = (s: string): string =>
    s
      .replace(/^`{3,}[a-z]*\s*/i, "")
      .replace(/`{3,}/g, "")
      .trim();
  const lines = reply
    .split("\n")
    .map((l) => clean(l.trim()))
    .filter((l) => l.startsWith("- "));
  const out: Array<{ title: string; acceptance: string }> = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const body = line.slice(2);
    const sep = body.indexOf("|");
    const title = clean(sep === -1 ? body : body.slice(0, sep));
    const acceptance = clean(sep === -1 ? title : body.slice(sep + 1).trim());
    // GLM-family models smear code fences into ticket lines — the fence strip
    // above recovers them; dedupe survives the rest.
    const key = title.toLowerCase();
    if (!title || key.length < 4 || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, acceptance });
    if (out.length >= 5) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * One-ticket dispatch prompt: objective restated (durable state re-injection)
 * and the current ticket in full, with hard boundaries and the verdict
 * contract.
 */
export function dispatchPrompt(opts: {
  objective: string;
  ticket: GoalTicket;
  ticketIndex: number;
  ticketCount: number;
  userText?: string;
}): string {
  const { objective, ticket, userText } = opts;
  const lines: string[] = [
    `# Goal loop dispatch (ticket ${opts.ticketIndex}/${opts.ticketCount})`,
    ``,
    `## Objective (unchanged across rounds)`,
    objective,
    ``,
    `## Your ticket for THIS round — work on exactly this, nothing else`,
    `- ${ticket.title}`,
    `- Acceptance: ${ticket.acceptance}`,
  ];
  if (ticket.feedback) {
    lines.push(`- Previous verification FAILED with: ${ticket.feedback}`);
  }
  if (userText) {
    lines.push(``, `## User message (steering this round)`, userText);
  }
  lines.push(
    ``,
    `## Rules`,
    `- Inspect the real current state before acting; do not rely on memory.`,
    `- Stay inside the scope of this ticket and the project directory.`,
    `- Verify your own work (run the acceptance check) before claiming done.`,
    ``,
    `## Return format (mandatory, last line of your reply)`,
    `VERDICT: met | not-yet | impossible`,
    `If not-yet: one short GAPS: line listing what remains.`,
    `If impossible: one short WHY: line.`,
  );
  return lines.join("\n");
}

/**
 * Verification turn: re-run acceptance criteria, never trust the report. The
 * verdict is WRITTEN TO A FILE in a fixed format (far more reliable than
 * parsing a prose reply — the bridge observed 11 rounds of re-doing finished
 * work before switching to the file contract); the reply text is only a
 * fallback.
 */
export function verifyPrompt(ticket: GoalTicket, verifyFile: string): string {
  return [
    `# Goal loop verification`,
    `The worker claims this ticket is complete:`,
    `- ${ticket.title}`,
    `- Acceptance: ${ticket.acceptance}`,
    ``,
    `Re-run the acceptance criteria YOURSELF (execute the checks, read the files`,
    `or diffs — do not trust the worker's summary or any transcript claims).`,
    ``,
    `Then write your verdict with the Write tool to EXACTLY this path:`,
    verifyFile,
    ``,
    `The file content must be EXACTLY one line, nothing else:`,
    `PASS`,
    `or`,
    `FAIL: <what specifically did not hold>`,
    ``,
    `Reply with only: DONE`,
  ].join("\n");
}

/**
 * Strict retry for an unreadable verification result: the verdict file was
 * missing or unparseable. One retry with this sharper contract; a still-
 * unreadable result pauses the loop instead of feeding a phantom FAIL back
 * (which loops forever).
 */
export function strictVerifyPrompt(ticket: GoalTicket, verifyFile: string): string {
  return [
    verifyPrompt(ticket, verifyFile),
    ``,
    `IMPORTANT: your previous verification produced no readable verdict file at`,
    `${verifyFile}. Write that file — one line, PASS or FAIL: <reason> — using the`,
    `Write tool. Do not reply with prose instead of writing the file.`,
  ].join("\n");
}

/** Parse the verification FILE (strict: single PASS / FAIL: line). */
export function parseVerifyFile(content: string): { pass: boolean; reason?: string } | null {
  const text = content.trim();
  if (text === "PASS" || text.startsWith("PASS\n")) return { pass: true };
  const m = /^FAIL:\s*(.+)/s.exec(text);
  if (m) return { pass: false, reason: m[1]!.trim().slice(0, 400) };
  return null;
}

/**
 * Parse the verification reply (fallback when no verdict file was written).
 * Explicit "FAIL:" wins; otherwise any affirmative pass/passed mention counts.
 * Negated statements ("2 of 5 checks did not pass") read as null — the safe
 * path (strict retry → pause), never a silent PASS.
 */
export function parseVerifyReply(reply: string): { pass: boolean; reason?: string } | null {
  const text = reply.trim();
  const m = /fail\s*:\s*(.+)/is.exec(text);
  if (m) return { pass: false, reason: m[1]!.trim().slice(0, 400) };
  const negated =
    /\b(not|never|cannot|can't|couldn't|didn't|doesn't|won't|fails?|failed|failing|unable)\b[^\n.]*?\bpass(ed)?\b/i
      .test(text) ||
    /\bpass(ed)?\b[^\n.]*?\b(not|never|cannot)\b/i.test(text);
  if (!negated && /\bpass(ed)?\b/i.test(text)) return { pass: true };
  return null;
}

/** The worker's self-reported verdict from the last assistant reply. */
export interface Verdict {
  kind: "met" | "not-yet" | "impossible";
  gaps?: string;
  why?: string;
}

/** Parse the trailing VERDICT line from a dispatch reply; null when absent. */
export function parseVerdict(reply: string): Verdict | null {
  const m = /VERDICT:\s*(met|not-yet|impossible)\b([^\n]*)/i.exec(reply);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() as Verdict["kind"];
  const rest = reply.slice(m.index + m[0].length);
  const gaps = /GAPS:\s*([^\n]+)/i.exec(rest)?.[1]?.trim();
  const why = /WHY:\s*([^\n]+)/i.exec(rest)?.[1]?.trim();
  return { kind, gaps, why };
}

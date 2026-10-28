import { resolveModelSelection } from "./models.js";
import {
  PROVIDER_PROTOCOL_VERSION,
  ProviderInputSchema,
  ProviderEventSchema,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderRegistration,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderCapability,
  type ProviderError,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import {
  SessionPersistenceStore,
  parsePersistence,
  persistenceHandle,
  type PersistenceData,
} from "./persistence.js";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";
import {
  assertRuntimeSupported,
  discoverRuntime,
  runRuntimeSmoke,
} from "./discovery/discover.js";
import {
  credentialStoreUnavailable,
  ZCodeHostBridge,
  type HostBridge,
} from "./host/bridge.js";
import { createRuntimeStatus } from "./provider-status.js";
import { logger } from "./logger.js";
import { MINIMUM_ZCODE_VERSION } from "./discovery/manifest.js";
import {
  diagnosticError,
  formatDiagnostic,
  runtimeDiagnostic,
} from "./diagnostics.js";
import { AdapterError } from "./errors.js";
import {
  catalogModels,
  decodeModel,
  encodeModel,
  mapMcpServers,
  requireConfigurableMode,
  zcodeModes,
} from "./mapping.js";
import {
  ZCodeSession,
  initializeWorkspace,
  resolveWorkspace,
} from "./session.js";
import { SessionSnapshotSchema, SessionListSchema } from "./host/schemas.js";
import { TimelineSnapshots } from "./timeline.js";
import { GoalDirectory } from "./goal.js";
import { parseGoalCommand } from "./goal-command.js";
import type { NativeSessionEvent } from "./session-types.js";
import type {
  ProviderMcpServerConfig,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import {
  defaultTimelinePreferences,
  type TimelinePreferences,
} from "../shared/timeline.js";
import {
  listSkillCommands,
  mergeSkillCommands,
  type SkillCommand,
} from "./skill-commands.js";

export const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.can_stop_runtime",
  "session.configure",
  "session.list",
  "session.metrics",
  "session.persistence",
  "permission",
] as const satisfies readonly ProviderCapability[];

export type BridgeFactory = (
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  workspace?: string,
) => Promise<HostBridge>;

export async function createHost(
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  workspace?: string,
): Promise<ZCodeHostBridge> {
  const env = { ...process.env, ...environment };
  const runtime = await discoverRuntime({ environment: env, signal });
  assertRuntimeSupported(runtime);
  try {
    const smoke = await runRuntimeSmoke(runtime, env, signal);
    if (!smoke.passed)
      throw diagnosticError(
        new AdapterError("RUNTIME_SMOKE_FAILED", "ZCode runtime smoke failed"),
        { stage: "smoke", check: "cli-smoke" },
      );
    signal.throwIfAborted();
    return ZCodeHostBridge.start(runtime, logger, env, workspace);
  } catch (error) {
    if (signal.aborted) throw error;
    throw diagnosticError(
      error,
      { ...runtimeDiagnostic(runtime), stage: "host-start" },
      "RUNTIME_DISCOVERY_FAILED",
    );
  }
}

// Paseo passes an agent's options, the provider defaults from `config.json`
// included, as `providerOptions`. Plan is ZCode's only option.
const optionsSchema = z.object({ plan_mode: z.boolean().optional() }).strict();
// A change may set an option to `null`, which returns it to the provider's
// default: Plan off.
const optionChangesSchema = z
  .object({ plan_mode: z.boolean().nullable().optional() })
  .strict();

interface SessionEntry {
  native: ZCodeSession;
  persistence: PersistenceData;
  submitted: boolean;
  bridge: HostBridge;
  unsubscribe: () => void;
  unsubscribeFailure: () => void;
  timeline: TimelineSnapshots;
  messages: Map<string, boolean>;
  inputGeneration: number;
  queue: Promise<void>;
  /** Removes the session from the goal directory. */
  forgetGoal: () => void;
  cwd: string;
  /** User/project skills, discovered async after open and merged into the slash list. */
  skills: SkillCommand[];
}

// The protocol app-server loads no MCP stores on its own — servers only reach a
// session through createSession params. Merge the user's CLI-configured servers
// (~/.zcode/cli/config.json mcp.servers) so they apply without per-agent setup.
type ZcodeConfigMcpEntry = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
};

function withZcodeConfigMcpServers(
  servers: Record<string, ProviderMcpServerConfig> | undefined,
): Record<string, ProviderMcpServerConfig> {
  const merged: Record<string, ProviderMcpServerConfig> = { ...servers };
  try {
    const raw = JSON.parse(
      readFileSync(join(homedir(), ".zcode", "cli", "config.json"), "utf8"),
    ) as { mcp?: { servers?: Record<string, ZcodeConfigMcpEntry> } };
    for (const [name, entry] of Object.entries(raw.mcp?.servers ?? {})) {
      if (entry?.enabled === false || merged[name] !== undefined) continue;
      if (typeof entry?.command === "string" && entry.command.trim() !== "") {
        merged[name] = {
          type: "stdio",
          command: entry.command,
          ...(entry.args ? { args: entry.args } : {}),
          ...(entry.env ? { env: entry.env } : {}),
        };
      } else if (typeof entry?.url === "string" && entry.url.trim() !== "") {
        merged[name] = {
          type: "http",
          url: entry.url,
          ...(entry.headers ? { headers: entry.headers } : {}),
        };
      }
    }
  } catch {
    // No readable CLI config: pass through Paseo-provided servers only.
  }
  return merged;
}
interface AttachedNative {
  host: HostBridge;
  native: ZCodeSession;
  snapshot: z.output<typeof SessionSnapshotSchema>;
}

let healNoticeSeq = 0;
export function createZCodeProvider(
  bridgeFactory: BridgeFactory = createHost,
  persistenceStore = new SessionPersistenceStore(),
  status: ProviderRegistration["status"] = createRuntimeStatus(),
  timeline: () => TimelinePreferences = () => defaultTimelinePreferences,
  goals = new GoalDirectory(),
  installation?: ProviderRegistration["installation"],
): ProviderRegistration {
  return {
    id: "zcode-native",
    label: "ZCode Native",
    description:
      "ZCode workspace agent with native planning, tools, and model selection",
    icon: "icon.svg",
    // Paseo links it from the provider page's Troubleshooting section.
    docsUrl:
      "https://github.com/supermomonga/paseo-plugin-zcode-provider#readme",
    // No `command`: Paseo would look it up on PATH, but the runtime is the
    // plugin's managed installation or the PASEO_ZCODE_* override.
    status,
    ...(installation ? { installation } : {}),
    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION))
        throw new Error("ZCode requires provider protocol version 1");
      return new ZCodeConnection(
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        bridgeFactory,
        persistenceStore,
        timeline,
        goals,
      );
    },
  };
}

export class ZCodeConnection implements ProviderConnection {
  readonly version = PROVIDER_PROTOCOL_VERSION;
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly opening = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly hosts = new Set<HostBridge>();
  /** In-flight dispatch-miss self-heals, keyed by public session id. */
  private readonly healing = new Map<string, Promise<boolean>>();
  private readonly abort = new AbortController();
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    readonly capabilities: readonly string[],
    private readonly bridgeFactory: BridgeFactory,
    private readonly persistenceStore: SessionPersistenceStore,
    private readonly timeline: () => TimelinePreferences,
    private readonly goals = new GoalDirectory(),
  ) {}

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    if (this.closed) throw new Error("ZCode connection is closed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(raw: ProviderInput): Promise<void> {
    if (this.closed) throw new Error("ZCode connection is closed");
    const input = ProviderInputSchema.parse(raw);
    requireProviderCapabilities(this.capabilities, input);
    if (input.type === "session.open") {
      if (
        this.sessions.has(input.sessionId) ||
        this.opening.has(input.sessionId)
      )
        throw new Error("Duplicate ZCode session ID");
      this.opening.add(input.sessionId);
    }
    if (
      input.type === "session.prompt" ||
      input.type === "session.configure" ||
      input.type === "session.interrupt"
    ) {
      // Dispatch-miss self-heal: the adapter process that owned this session
      // died (reaped, crashed, daemon restart). Rebuild it from the resume
      // index so history stays continuable; without an index (never opened
      // here, or properly closed) keep the historical error.
      if (
        !this.sessions.has(input.sessionId) &&
        !this.opening.has(input.sessionId) &&
        !(await this.healSession(input.sessionId))
      )
        throw new AdapterError("SESSION_NOT_FOUND", "Unknown ZCode session");
    }
    if (input.type === "session.prompt") {
      const entry = this.requireSession(input.sessionId);
      if (entry.messages.has(input.prompt.clientMessageId))
        throw new Error("Duplicate ZCode clientMessageId");
      entry.messages.set(input.prompt.clientMessageId, false);
    }
    if (input.type === "session.interrupt")
      this.requireSession(input.sessionId).inputGeneration++;
    const entry =
      input.type === "session.prompt" || input.type === "session.configure"
        ? this.requireSession(input.sessionId)
        : undefined;
    const releaseInput =
      input.type === "session.prompt"
        ? entry!.native.reserveInput()
        : undefined;
    const inputGeneration = entry?.inputGeneration;
    const operation = entry
      ? entry.queue.then(() => {
          if (
            input.type === "session.prompt" &&
            inputGeneration !== entry.inputGeneration
          )
            throw new AdapterError(
              "SESSION_BUSY",
              "ZCode input was cancelled before sending",
            );
          return this.dispatch(input);
        })
      : this.dispatch(input);
    if (entry) entry.queue = operation.catch(() => undefined);
    const job = operation
      .catch((cause: unknown) => {
        const error = diagnosticError(
          cause,
          {
            ...entry?.bridge.diagnostic,
            stage: "request",
            operation: input.type,
          },
          "INVALID_CONFIGURATION",
        );
        logger.error("zcode.provider.request_failed", error);
        if (input.type === "session.prompt") {
          const promptEntry = entry ?? this.sessions.get(input.sessionId);
          if (promptEntry?.messages.get(input.prompt.clientMessageId)) return;
          // The input was not admitted. Paseo's interrupt-and-replace fallback
          // for an unavailable steer resends it with the same ID.
          promptEntry?.messages.delete(input.prompt.clientMessageId);
          this.emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "failed", error: publicError(error) },
          });
        } else if ("requestId" in input) {
          this.emit({
            type: "request.failed",
            requestId: input.requestId,
            error: publicError(error),
          });
        } else {
          // Permission send has no request ID; fail and close the native runtime too.
          const entry = this.sessions.get(input.sessionId);
          if (entry)
            entry.native.runtimeFailed(
              error instanceof AdapterError
                ? error
                : new AdapterError(
                    "NATIVE_PROTOCOL_ERROR",
                    "ZCode permission response failed",
                  ),
            );
          else
            this.emit({
              type: "session.runtime_failed",
              sessionId: input.sessionId,
              error: publicError(error),
            });
        }
      })
      .finally(() => {
        releaseInput?.();
        this.jobs.delete(job);
        if (input.type === "session.open") this.opening.delete(input.sessionId);
      });
    this.jobs.add(job);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort.abort();
    this.closing = this.closeAll();
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    // Closing the transport rejects pending RPCs and releases turns awaiting a terminal event.
    for (const entry of this.sessions.values()) entry.native.runtimeFailed();
    await Promise.allSettled([
      ...[...this.sessions.keys()].map((id) => this.closeSession(id)),
      ...[...this.hosts].map((host) => host.close()),
    ]);
    await Promise.allSettled([...this.jobs]);
    this.listeners.clear();
  }

  private async host(
    env: Readonly<Record<string, string>>,
    workspace: string,
  ): Promise<HostBridge> {
    const host = await this.bridgeFactory(env, this.abort.signal, workspace);
    if (this.closed) {
      await host.close();
      throw new Error("ZCode connection is closed");
    }
    this.hosts.add(host);
    return host;
  }

  private async dispatch(input: ProviderInput): Promise<void> {
    if (input.type === "catalog" || input.type === "sessions") {
      if (input.type === "sessions" && !input.cwd)
        throw new AdapterError(
          "INVALID_WORKSPACE",
          "ZCode session listing requires a workspace",
        );
      const cwd = await resolveWorkspace(input.cwd ?? homedir());
      const host = await this.host({}, cwd);
      try {
        const { presentation, selection } = await initializeWorkspace(
          host,
          cwd,
        );
        if (input.type === "catalog") {
          const models = catalogModels(
            selection.models,
            selection.preferredSelection,
          );
          this.emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models,
              modes: zcodeModes(host.diagnostic.appVersion),
              defaultModel: models.find((model) => model.isDefault)?.id,
              defaultMode: presentation.mode,
            },
          });
        } else {
          const rows = await host.request(
            "listSessions",
            { workspacePath: cwd, includeArchived: false },
            SessionListSchema,
          );
          const sessions = rows
            .map((row) => {
              if (row.workspace.workspacePath !== cwd)
                throw new AdapterError(
                  "INVALID_WORKSPACE",
                  "ZCode returned a session from another workspace",
                );
              return {
                persistence: {
                  version: 3,
                  data: { kind: "native", sessionId: row.sessionId, cwd },
                },
                cwd,
                title: row.title,
                ...(row.updatedAt === undefined
                  ? {}
                  : { updatedAt: new Date(row.updatedAt).toISOString() }),
              };
            })
            .filter(
              (row) =>
                !input.query ||
                (row.title ?? "")
                  .toLowerCase()
                  .includes(input.query.toLowerCase()),
            )
            .slice(0, input.limit);
          this.emit({ type: "sessions", requestId: input.requestId, sessions });
        }
      } finally {
        this.hosts.delete(host);
        await host.close();
      }
      return;
    }
    if (input.type === "session.open") return this.openSession(input);
    if (
      input.type === "session.archive" ||
      input.type === "session.unarchive" ||
      input.type === "session.revert"
    )
      throw new Error("Unsupported ZCode operation");
    const entry = this.requireSession(input.sessionId);
    switch (input.type) {
      case "session.prompt": {
        const prompt = input.prompt.input;
        if (input.prompt.delivery === "steer" && !entry.native.hasActiveTurn())
          throw new AdapterError(
            "SESSION_BUSY",
            "ZCode has no active turn to steer",
          );
        if (
          entry.native.hasActiveTurn() &&
          (prompt.type === "command" ||
            prompt.content.some(
              (part) => part.type === "text" && /^\s*\//.test(part.text),
            ))
        )
          throw new AdapterError(
            "SESSION_BUSY",
            "Commands cannot run while ZCode is processing input",
          );
        if (
          prompt.type === "command" &&
          !entry.native
            .listCommands()
            .some((command) => command.name === prompt.name) &&
          !entry.skills.some((skill) => skill.name === prompt.name)
        )
          throw new Error("Unknown ZCode command");
        // ZCode desktop implements /plan as setMode plus an optional task.
        // Native text admission does not interpret this shortcut.
        const text =
          prompt.type === "message" && prompt.content[0]?.type === "text"
            ? prompt.content[0].text.trim()
            : undefined;
        const planTask =
          prompt.type === "command" && prompt.name === "plan"
            ? prompt.arguments.trim()
            : (text?.match(/^\/plan(?:\s+([\s\S]*))?$/)?.[1]?.trim() ??
              (text === "/plan" ? "" : undefined));
        // The command ran without a turn.
        const completed = () => {
          entry.messages.set(input.prompt.clientMessageId, true);
          this.emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "completed" },
          });
        };
        const beforeSend = async () => {
          if (!entry.submitted) {
            await this.persistenceStore.save(
              entry.persistence,
              entry.native.id,
            );
            entry.submitted = true;
          }
        };
        if (planTask !== undefined) {
          if (prompt.type === "message" && prompt.content.length !== 1)
            throw new AdapterError(
              "INVALID_CONFIGURATION",
              "The /plan shortcut requires text without attachments",
            );
          await entry.native.configureMode(undefined, true);
          if (!planTask) {
            completed();
            return;
          }
        }
        const command =
          prompt.type === "command"
            ? `/${prompt.name}${prompt.arguments ? ` ${prompt.arguments}` : ""}`
            : undefined;
        // Like /plan, /goal is not text to the Server: ZCode Desktop sends the
        // V4 goal commands for it (ADR 27).
        const goalText =
          command ??
          (prompt.type === "message" && prompt.content.length === 1
            ? text
            : undefined);
        const goal =
          planTask === undefined && goalText !== undefined
            ? parseGoalCommand(goalText)
            : undefined;
        if (goal?.kind === "empty" || goal?.kind === "unsupported")
          throw new AdapterError(
            "INVALID_CONFIGURATION",
            goal.kind === "empty"
              ? "Usage: /goal <objective>, /goal pause or /goal resume"
              : `ZCode's Server has no /goal ${goal.action}. Use /goal <objective> to replace the goal, or /goal pause.`,
          );
        if (goal?.kind === "pause") {
          await entry.native.pauseGoal();
          completed();
          return;
        }
        if (goal) {
          await entry.native.startGoal(goal, {
            clientMessageId: input.prompt.clientMessageId,
            beforeSend,
          });
          return;
        }
        await entry.native.startTurn(
          planTask ?? (prompt.type === "command" ? command! : prompt.content),
          {
            clientMessageId: input.prompt.clientMessageId,
            delivery: input.prompt.delivery,
            clearPendingPermissions: input.prompt.clearPendingPermissions,
            beforeSend,
          },
        );
        return;
      }
      case "session.configure": {
        const options = optionChangesSchema.parse(
          input.changes.providerOptions ?? {},
        );
        const plan = options.plan_mode === null ? false : options.plan_mode;
        requireConfigurableMode(input.changes.mode);
        if (input.changes.model !== undefined)
          await entry.native.setModel(input.changes.model);
        if (input.changes.thinkingOption !== undefined)
          await entry.native.setThinkingOption(input.changes.thinkingOption);
        if (input.changes.mode !== undefined || plan !== undefined)
          await entry.native.configureMode(input.changes.mode, plan);
        this.emitConfig(input.sessionId, entry);
        break;
      }
      case "session.interrupt":
        await entry.native.interrupt();
        break;
      // Paseo asks before releasing an idle runtime; the answer is the reply.
      case "session.can_stop_runtime":
        this.emit({
          type: "session.can_stop_runtime",
          requestId: input.requestId,
          sessionId: input.sessionId,
          canStop: entry.native.canStopRuntime(),
        });
        return;
      case "session.permission":
        await entry.native.respondToPermission(
          input.permissionId,
          input.response,
        );
        return;
      case "session.close":
        await this.closeSession(input.sessionId);
        await this.persistenceStore.deleteIndex(input.sessionId);
        this.emit({ type: "session.closed", sessionId: input.sessionId });
        return;
    }
    this.emit({ type: "request.completed", requestId: input.requestId });
  }

  private async openSession(
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<void> {
    const config = input.config;
    // The deprecated `settings` repeats the same values.
    const options = optionsSchema.parse(config.providerOptions ?? {});
    requireConfigurableMode(config.mode);
    if (config.systemPrompt?.trim())
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "ZCode does not support custom system prompts. Remove any added by Paseo's System prompt setting (Orchestration) or by another plugin.",
      );
    if (!config.persist)
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "The verified ZCode host requires persistent sessions",
      );
    const cwd = await resolveWorkspace(config.cwd);
    const persistence = input.persistence
      ? parsePersistence(input.persistence)
      : { kind: "logical" as const, id: randomUUID(), cwd };
    if (persistence.cwd !== cwd)
      throw new AdapterError(
        "INVALID_WORKSPACE",
        "ZCode persistence belongs to another workspace",
      );
    const nativeId = await this.persistenceStore.resolve(persistence);
    const { host, native, snapshot } = await this.attachNative(
      persistence,
      config,
      nativeId,
    );
    try {
      if (this.closed) throw new Error("ZCode connection is closed");
      const entry = this.registerSession(input.sessionId, {
        native,
        host,
        persistence,
        cwd,
        submitted: nativeId !== undefined,
      });
      // Paseo sets PASEO_AGENT_ID in the launch environment of every session.
      const agentId = config.env.PASEO_AGENT_ID;
      if (agentId) {
        const session = native;
        entry.forgetGoal = this.goals.register(agentId, {
          read: () => session.goal(),
          watch: (changed) => session.watchGoal(changed),
        });
      }
      try {
        await this.persistenceStore.saveIndex(input.sessionId, {
          version: 1,
          handle: persistence,
          config: {
            cwd,
            env: { ...config.env },
            ...(config.model === undefined ? {} : { model: config.model }),
            ...(config.thinkingOption === undefined
              ? {}
              : { thinkingOption: config.thinkingOption }),
            mcpServers: { ...config.mcpServers },
          },
        });
      } catch (error) {
        // Best-effort: a failed index write must not fail the open itself.
        // The session just stays un-resumable after adapter death, which is
        // the pre-self-heal behavior anyway (ADR-0020).
        logger.error("zcode.provider.resume_index_write_failed", error);
      }
      this.emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        capabilities: this.capabilities,
        restoration: "core",
        persistence: persistenceHandle(persistence),
        cwd,
        title: config.title ?? snapshot.session.title,
      });
      this.emitConfig(input.sessionId, entry);
      this.startSkillDiscovery(input.sessionId, entry);
      if (input.history === "replay")
        for (const { item, timestamp } of native.historyItems())
          this.emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: entry.timeline.replay(item),
            timestamp,
          });
      this.wireNativeEvents(input.sessionId, entry);
      if (!this.sessions.has(input.sessionId))
        throw new AdapterError(
          "NATIVE_EXITED",
          "ZCode disconnected during session open",
        );
      this.emitPendingPermissions(input.sessionId, native);
      this.emit({
        type: "session.ready",
        requestId: input.requestId,
        sessionId: input.sessionId,
      });
    } catch (error) {
      this.sessions.delete(input.sessionId);
      try {
        await native.close();
      } finally {
        this.hosts.delete(host);
        await host.close();
      }
      throw error;
    }
  }

  /** Open or resume the native conversation behind a persistence handle.
   *  Owns host/native cleanup on failure; the caller owns registry and
   *  event-lifecycle concerns. */
  private async attachNative(
    persistence: PersistenceData,
    config: ProviderSessionConfig,
    nativeId: string | undefined,
  ): Promise<AttachedNative> {
    const cwd = persistence.cwd;
    const host = await this.host(config.env, cwd);
    let native: ZCodeSession | undefined;
    let forgetGoal = () => {};
    try {
      const { selection } = await initializeWorkspace(host, cwd);
      const requested = nativeId
        ? undefined
        : config.model === undefined
          ? selection.preferredSelection
          : decodeModel(config.model);
      const initialModel =
        requested &&
        (await resolveModelSelection(host, selection, {
          ...requested,
          ...(config.thinkingOption !== undefined
            ? { options: { reasoningLevel: config.thinkingOption } }
            : {}),
        }));
      let snapshot: z.output<typeof SessionSnapshotSchema>;
      try {
        snapshot = await host.request(
          nativeId ? "resumeSession" : "createSession",
          {
            workspacePath: cwd,
            ...(nativeId
              ? { sessionId: nativeId }
              : {
                  persistence: "deferred",
                  // session/create converts model to provider/model internally;
                  // the native create contract takes the reasoning level separately.
                  ...(initialModel
                    ? {
                        model: initialModel,
                        thoughtLevel: initialModel.options?.reasoningLevel,
                      }
                    : {}),
                }),
            mcpServers: mapMcpServers(
              withZcodeConfigMcpServers(config.mcpServers),
              host.diagnostic.appVersion,
            ),
          },
          SessionSnapshotSchema,
          60000,
        );
      } catch (error) {
        // Distinguish "the runtime no longer knows this native session" from
        // every other failure: only the former may trigger the heal fallback
        // (ADR-0020); spawn/workspace/transport errors must surface as-is.
        if (nativeId === undefined) throw error;
        throw new AdapterError(
          "SESSION_NOT_FOUND",
          `ZCode could not resume native session ${nativeId}`,
          {},
          { cause: error },
        );
      }
      if (nativeId && snapshot.session.sessionId !== nativeId)
        throw new Error("ZCode resumed a different session");
      native = await ZCodeSession.create({
        bridge: host,
        logger,
        workspace: cwd,
        snapshot,
        modelCatalog: selection.models,
        timeline: this.timeline,
        onClose() {},
        // A non-empty list replaces ZCode's MCP configuration files.
        projectMcpServers: Object.keys(config.mcpServers ?? {}).length === 0,
      });
      if (
        initialModel &&
        (native.getConfig().model !== encodeModel(initialModel) ||
          native.getConfig().thinkingOption !==
            initialModel.options?.reasoningLevel)
      )
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode did not apply the requested initial model selection",
        );
      await native.applyInitialConfig({
        ...config,
        ...(nativeId
          ? {}
          : {
              model: undefined,
              ...(initialModel ? { thinkingOption: undefined } : {}),
            }),
        providerOptions: {
          ...options,
          ...(!nativeId && options.plan_mode === undefined
            ? { plan_mode: false }
            : {}),
        },
      });
      return { host, native, snapshot };
    } catch (error) {
      try {
        await native?.close();
      } finally {
        this.hosts.delete(host);
        await host.close();
      }
      throw error;
    }
  }

  private registerSession(
    sessionId: string,
    parts: {
      native: ZCodeSession;
      host: HostBridge;
      persistence: PersistenceData;
      cwd: string;
      submitted: boolean;
    },
  ): SessionEntry {
    const entry: SessionEntry = {
      native: parts.native,
      persistence: parts.persistence,
      submitted: parts.submitted,
      bridge: parts.host,
      unsubscribe() {},
      unsubscribeFailure() {},
      timeline: new TimelineSnapshots(),
      messages: new Map(),
      inputGeneration: 0,
      queue: Promise.resolve(),
      cwd: parts.cwd,
      forgetGoal() {},
      skills: [],
    };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  /** Dispatch-miss self-heal: rebuild a session whose adapter process died,
   *  from the resume index written at open. Returns false when no index
   *  exists (never opened here, or properly closed) so the caller keeps the
   *  historical SESSION_NOT_FOUND error. */
  private healSession(sessionId: string): Promise<boolean> {
    const inFlight = this.healing.get(sessionId);
    if (inFlight) return inFlight;
    const job = this.heal(sessionId).finally(() =>
      this.healing.delete(sessionId),
    );
    this.healing.set(sessionId, job);
    return job;
  }

  private async heal(sessionId: string): Promise<boolean> {
    const index = await this.persistenceStore.loadIndex(sessionId);
    if (!index) return false;
    // Fail early — before any host spawn — when the workspace is gone, so the
    // historical workspace error surfaces instead of a resume/fallback dance.
    await resolveWorkspace(index.config.cwd);
    // Model/thinking ride along so a fallback fresh session keeps the user's
    // selection; settings/mode are intentionally NOT stored (ADR-0014: never
    // infer or duplicate settings) — a resumed native session carries its own.
    const config: ProviderSessionConfig = {
      cwd: index.config.cwd,
      env: index.config.env ?? {},
      mcpServers: index.config.mcpServers as Record<
        string,
        ProviderMcpServerConfig
      >,
      settings: {},
      persist: true,
      providerOptions: {},
      ...(index.config.model === undefined
        ? {}
        : { model: index.config.model }),
      ...(index.config.thinkingOption === undefined
        ? {}
        : { thinkingOption: index.config.thinkingOption }),
    };
    const nativeId = await this.persistenceStore.resolve(index.handle);
    let persistence = index.handle;
    let parts: AttachedNative;
    let fallbackFrom: string | undefined;
    try {
      parts = await this.attachNative(persistence, config, nativeId);
    } catch (error) {
      // Only a resume rejection may trigger the fresh-session fallback
      // (ADR-0020). Spawn/workspace/transport errors surface as-is.
      if (
        nativeId === undefined ||
        !(error instanceof AdapterError) ||
        error.code !== "SESSION_NOT_FOUND"
      )
        throw error;
      // The runtime no longer knows the native session (the tree died before
      // ZCode checkpointed it). Continue on a fresh conversation instead of
      // failing the dispatch; the old timeline stays viewable in Paseo.
      fallbackFrom = nativeId;
      persistence = {
        kind: "logical",
        id: randomUUID(),
        cwd: index.config.cwd,
      };
      parts = await this.attachNative(persistence, config, undefined);
      // Point the index at the replacement conversation so a SECOND process
      // death resumes the fallback session instead of falling back again.
      await this.persistenceStore.saveIndex(sessionId, {
        version: 1,
        handle: persistence,
        config: index.config,
      });
    }
    const entry = this.registerSession(sessionId, {
      native: parts.native,
      host: parts.host,
      persistence,
      cwd: index.config.cwd,
      submitted: nativeId !== undefined && !fallbackFrom,
    });
    if (fallbackFrom)
      this.emit({
        type: "session.notice",
        sessionId,
        notice: {
          id: `resume-fallback-${++healNoticeSeq}`,
          severity: "warning",
          title: "Resumed without prior context",
          description: `ZCode could not restore native session ${fallbackFrom}; a new conversation was started. Earlier messages remain visible in the timeline.`,
        },
      });
    this.emitConfig(sessionId, entry);
    this.emitPendingPermissions(sessionId, parts.native);
    this.wireNativeEvents(sessionId, entry);
    this.startSkillDiscovery(sessionId, entry);
    return true;
  }

  private wireNativeEvents(sessionId: string, entry: SessionEntry): void {
    entry.unsubscribe = entry.native.subscribe((event) =>
      this.accept(sessionId, entry, event),
    );
    entry.unsubscribeFailure = entry.bridge.onFailure((error) =>
      entry.native.runtimeFailed(error),
    );
  }

  private emitPendingPermissions(
    sessionId: string,
    native: ZCodeSession,
  ): void {
    for (const request of native.getPendingPermissions())
      this.emit({ type: "session.permission", sessionId, request });
  }

  private startSkillDiscovery(sessionId: string, entry: SessionEntry): void {
    // Skills load async: refresh the command list once discovery lands.
    void listSkillCommands(entry.cwd).then(
      (skills) => {
        if (this.sessions.get(sessionId) !== entry || !skills.length) return;
        entry.skills = skills;
        this.emitConfig(sessionId, entry);
      },
      () => {},
    );
  }

  private emitConfig(id: string, entry: SessionEntry): void {
    const commands = entry.native.listCommands();
    // The runtime's protocol command list omits skills entirely (they are a
    // TUI-side surface), so the provider reports them itself — otherwise
    // Paseo's slash autocomplete never shows /to-prd & co.
    const withSkills = [
      ...commands,
      ...mergeSkillCommands(commands, [], entry.skills).map((skill) => ({
        name: skill.name,
        description: skill.description || "ZCode skill",
        argumentHint: `/${skill.name}`,
      })),
    ];
    this.emit({
      type: "session.config",
      sessionId: id,
      config: entry.native.getConfig(),
    });
    this.emit({
      type: "session.commands",
      sessionId: id,
      commands: withSkills,
    });
  }

  private accept(
    id: string,
    entry: SessionEntry,
    event: NativeSessionEvent,
  ): void {
    switch (event.type) {
      case "timeline":
        this.emit({
          type: "timeline.item",
          sessionId: id,
          item: entry.timeline.live(event.item, event.turnId),
          timestamp: event.timestamp,
        });
        break;
      case "usage_updated":
        this.emit({
          type: "session.usage",
          sessionId: id,
          turnId: event.turnId,
          usage: event.usage,
        });
        break;
      case "prompt_accepted":
        if (!entry.messages.has(event.clientMessageId))
          throw new Error("ZCode accepted an unrequested input");
        if (entry.messages.get(event.clientMessageId))
          throw new Error("ZCode accepted an input twice");
        entry.messages.set(event.clientMessageId, true);
        this.emit({
          type: "session.prompt_result",
          sessionId: id,
          clientMessageId: event.clientMessageId,
          result: { type: event.delivery, turnId: event.turnId },
        });
        break;
      case "turn_started":
        this.emit({
          type: "session.turn",
          sessionId: id,
          turnId: event.turnId,
          state: "started",
        });
        break;
      case "metrics_updated":
        // A Paseo that did not offer session.metrics closes the connection
        // on this event.
        if (this.capabilities.includes("session.metrics"))
          this.emit({
            type: "session.metrics",
            sessionId: id,
            metrics: event.metrics,
          });
        break;
      case "turn_completed":
      case "turn_canceled":
        this.emit({
          type: "session.turn",
          sessionId: id,
          turnId: event.turnId,
          state: event.type === "turn_completed" ? "completed" : "canceled",
          ...(event.metrics?.length ? { metrics: event.metrics } : {}),
        });
        break;
      case "turn_failed":
        if (event.turnId)
          this.emit({
            type: "session.turn",
            sessionId: id,
            turnId: event.turnId,
            state: "failed",
            error: {
              code: event.code,
              message: event.error,
              diagnostic: event.diagnostic,
            },
          });
        break;
      case "runtime_failed": {
        this.emit({
          type: "session.runtime_failed",
          sessionId: id,
          error: {
            code: event.code,
            message: "ZCode session failed",
            diagnostic: event.diagnostic,
          },
        });
        if (this.sessions.get(id) !== entry) break;
        const cleanup = this.closeSession(id)
          .catch(() => undefined)
          .finally(() => this.jobs.delete(cleanup));
        this.jobs.add(cleanup);
        break;
      }
      case "permission_requested":
        this.emit({
          type: "session.permission",
          sessionId: id,
          request: event.request,
        });
        break;
      case "permission_resolved":
        this.emit({
          type: "session.permission_resolved",
          sessionId: id,
          permissionId: event.requestId,
        });
        break;
      case "config_changed":
        this.emitConfig(id, entry);
        break;
    }
  }

  private requireSession(id: string): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry)
      throw new AdapterError("SESSION_NOT_FOUND", "Unknown ZCode session");
    return entry;
  }

  private async closeSession(id: string): Promise<void> {
    const entry = this.requireSession(id);
    this.sessions.delete(id);
    entry.forgetGoal();
    try {
      await entry.native.close();
    } finally {
      entry.unsubscribe();
      entry.unsubscribeFailure();
      this.hosts.delete(entry.bridge);
      await entry.bridge.close();
    }
  }

  private emit(event: ProviderEvent): void {
    if (this.closed) return;
    const valid = ProviderEventSchema.parse(event);
    for (const listener of this.listeners) listener(valid);
  }
}

function publicError(error: unknown): ProviderError {
  const messages: Record<string, string> = {
    UNSUPPORTED_ZCODE: `ZCode requires stable app >=${MINIMUM_ZCODE_VERSION.app} and bundled CLI >=${MINIMUM_ZCODE_VERSION.cli}.`,
    RUNTIME_DISCOVERY_FAILED:
      "ZCode installation or required host structure could not be inspected. See the diagnostic for the failure stage.",
    RUNTIME_SETUP_REQUIRED:
      "ZCode runtime is not set up. Install it in Settings → Plugins → ZCode Provider → Runtime.",
    AUTH_REQUIRED:
      "No ZCode model provider is usable. Sign in or add a provider in Settings → Plugins → ZCode Provider → Account.",
    CREDENTIAL_STORE_UNAVAILABLE: credentialStoreUnavailable().message,
    WINDOWS_RUNTIME_HOST_MISSING:
      "ZCode 3.18 needs zcode-runtime-host.exe on Windows to start its Agent. The managed runtime includes it; with PASEO_ZCODE_RUNTIME, set ZCODE_RUNTIME_HOST_PATH for the Paseo daemon to ZCode's zcode-runtime-host.exe.",
    MODEL_UNAVAILABLE:
      "ZCode cannot use the selected model. Choose another model, or check the account and model providers in Settings → Plugins → ZCode Provider → Account.",
    PERSISTENCE_VERSION_UNSUPPORTED:
      "ZCode persistence version is unsupported. Create a new Paseo ZCode session.",
    PERSISTENCE_INVALID:
      "ZCode resume information is unreadable or invalid. No replacement conversation was created.",
    PERSISTENCE_WRITE_FAILED:
      "ZCode resume information could not be saved. The prompt was not sent.",
  };
  // diagnosticError keeps the thrown error as the cause. Only a configuration
  // reason the plugin raised itself is shown; wrapped native or unexpected
  // failures keep the generic text.
  const configurationReason =
    error instanceof AdapterError &&
    error.code === "INVALID_CONFIGURATION" &&
    error.cause instanceof AdapterError
      ? error.message
      : undefined;
  return {
    diagnostic: formatDiagnostic(error),
    code: error instanceof AdapterError ? error.code : "INVALID_CONFIGURATION",
    message:
      error instanceof AdapterError
        ? (messages[error.code] ??
          configurationReason ??
          `ZCode operation failed (${error.code})`)
        : "Invalid ZCode provider request",
  };
}

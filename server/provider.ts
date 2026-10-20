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
import {
  assertRuntimeSupported,
  discoverRuntime,
  runRuntimeSmoke,
} from "./discovery/discover.js";
import { ZCodeHostBridge, type HostBridge } from "./host/bridge.js";
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
  ZCODE_MODES,
} from "./mapping.js";
import {
  ZCodeSession,
  initializeWorkspace,
  resolveWorkspace,
} from "./session.js";
import { SessionSnapshotSchema, SessionListSchema } from "./host/schemas.js";
import { TimelineSnapshots } from "./timeline.js";
import type { NativeSessionEvent } from "./session-types.js";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";
import {
  GoalLoopDriver,
  runDriverTurn,
  statusTextOf,
  type GoalLoopHost,
} from "./goal-loop/driver.js";
import { clearGoalState, readGoalState } from "./goal-loop/state.js";
import {
  formatGoalStatus,
  GoalModeAdapter,
  GoalModeUnavailableError,
  routeGoalCommand,
} from "./goal-mode/adapter.js";
import {
  listSkillCommands,
  mergeSkillCommands,
  type SkillCommand,
} from "./skill-commands.js";

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

export const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.list",
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

const optionsSchema = z.object({}).strict();
const settingsSchema = z.object({ plan_mode: z.boolean().optional() }).strict();

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
  cwd: string;
  /** Sticky: the runtime refused the official goal command once — future /goal starts go straight to the plugin loop. */
  goalModeBlocked: boolean;
  /** User/project skills, discovered async after open and merged into the slash list. */
  skills: SkillCommand[];
}

type SessionPromptRequest = Extract<ProviderInput, { type: "session.prompt" }>["prompt"];

type GoalCommand = { label: "goal" | "auto"; arg: string };

let goalNoteSeq = 0;

/** Extract /goal and /auto (command or leading-slash text) prompts. */
function goalCommandOf(prompt: SessionPromptRequest): GoalCommand | null {
  const p = prompt.input;
  if (p.type === "command") {
    if (p.name === "goal" || p.name === "auto")
      return { label: p.name, arg: p.arguments.trim() };
    return null;
  }
  if (p.type === "message" && p.content.length === 1) {
    const part = p.content[0];
    if (part?.type !== "text") return null;
    const m = /^\/(goal|auto)(?:\s+([\s\S]+))?$/.exec(part.text.trim());
    if (m) return { label: m[1] as GoalCommand["label"], arg: (m[2] ?? "").trim() };
  }
  return null;
}

export function createZCodeProvider(
  bridgeFactory: BridgeFactory = createHost,
  persistenceStore = new SessionPersistenceStore(),
  status: ProviderRegistration["status"] = createRuntimeStatus(),
): ProviderRegistration {
  return {
    id: "zcode-native",
    label: "ZCode Native",
    description:
      "ZCode workspace agent with native planning, tools, and model selection",
    icon: "icon.svg",
    // No `command`: Paseo would look it up on PATH, but the runtime is the
    // plugin's managed installation or the PASEO_ZCODE_* override.
    status,
    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION))
        throw new Error("ZCode requires provider protocol version 1");
      return new ZCodeConnection(
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        bridgeFactory,
        persistenceStore,
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
  private readonly goalLoops = new Map<string, GoalLoopDriver>();
  private readonly abort = new AbortController();
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    readonly capabilities: readonly string[],
    private readonly bridgeFactory: BridgeFactory,
    private readonly persistenceStore: SessionPersistenceStore,
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
          promptEntry?.messages.set(input.prompt.clientMessageId, true);
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
              modes: ZCODE_MODES,
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
        // /goal and /auto bypass the native text path entirely: they drive the
        // bridge-ported goal loop instead of reaching the model as raw text.
        const goal = goalCommandOf(input.prompt);
        if (goal) {
          await this.handleGoalCommand(input, entry, goal.label, goal.arg);
          return;
        }
        if (input.prompt.clearPendingPermissions)
          throw new AdapterError(
            "INTERACTION_UNSUPPORTED",
            "Steering does not resolve pending ZCode permissions",
          );
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
          !entry.native.listCommands().some((command) => command.name === prompt.name) &&
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
        if (planTask !== undefined) {
          if (prompt.type === "message" && prompt.content.length !== 1)
            throw new AdapterError(
              "INVALID_CONFIGURATION",
              "The /plan shortcut requires text without attachments",
            );
          await entry.native.configureMode(undefined, true);
          if (!planTask) {
            entry.messages.set(input.prompt.clientMessageId, true);
            this.emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "completed" },
            });
            return;
          }
        }
        await entry.native.startTurn(
          planTask ??
            (prompt.type === "command"
              ? `/${prompt.name}${prompt.arguments ? ` ${prompt.arguments}` : ""}`
              : prompt.content),
          {
            clientMessageId: input.prompt.clientMessageId,
            delivery: input.prompt.delivery,
            beforeSend: async () => {
              if (!entry.submitted) {
                await this.persistenceStore.save(
                  entry.persistence,
                  entry.native.id,
                );
                entry.submitted = true;
              }
            },
          },
        );
        return;
      }
      case "session.configure": {
        const settings = settingsSchema.parse(input.changes.settings ?? {});
        if (
          input.changes.mode !== undefined &&
          !ZCODE_MODES.some((mode) => mode.id === input.changes.mode)
        )
          throw new AdapterError(
            "INVALID_CONFIGURATION",
            "ZCode editing mode must be build, edit, or yolo",
          );
        if (input.changes.model !== undefined)
          await entry.native.setModel(input.changes.model);
        if (input.changes.thinkingOption !== undefined)
          await entry.native.setThinkingOption(input.changes.thinkingOption);
        if (
          input.changes.mode !== undefined ||
          settings.plan_mode !== undefined
        )
          await entry.native.configureMode(
            input.changes.mode,
            settings.plan_mode,
          );
        this.emitConfig(input.sessionId, entry);
        break;
      }
      case "session.interrupt":
        await entry.native.interrupt();
        break;
      case "session.permission":
        await entry.native.respondToPermission(
          input.permissionId,
          input.response,
        );
        return;
      case "session.close":
        await this.closeSession(input.sessionId);
        this.emit({ type: "session.closed", sessionId: input.sessionId });
        return;
    }
    this.emit({ type: "request.completed", requestId: input.requestId });
  }

  private async openSession(
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<void> {
    const config = input.config;
    optionsSchema.parse(config.providerOptions ?? {});
    const settings = settingsSchema.parse(config.settings);
    if (
      config.mode !== undefined &&
      !ZCODE_MODES.some((mode) => mode.id === config.mode)
    )
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "ZCode editing mode must be build, edit, or yolo",
      );
    if (config.systemPrompt?.trim())
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "Custom system prompts are unsupported by the verified ZCode host",
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
    const host = await this.host(config.env, cwd);
    let native: ZCodeSession | undefined;
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
      const snapshot = await host.request(
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
          mcpServers: mapMcpServers(withZcodeConfigMcpServers(config.mcpServers)),
        },
        SessionSnapshotSchema,
        60000,
      );
      if (nativeId && snapshot.session.sessionId !== nativeId)
        throw new Error("ZCode resumed a different session");
      native = await ZCodeSession.create({
        bridge: host,
        logger,
        workspace: cwd,
        snapshot,
        modelCatalog: selection.models,
        onClose() {},
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
        settings: {
          ...settings,
          ...(!nativeId && settings.plan_mode === undefined
            ? { plan_mode: false }
            : {}),
        },
      });
      if (this.closed) throw new Error("ZCode connection is closed");
      const entry: SessionEntry = {
        native,
        persistence,
        submitted: nativeId !== undefined,
        bridge: host,
        unsubscribe() {},
        unsubscribeFailure() {},
        timeline: new TimelineSnapshots(),
        messages: new Map(),
        inputGeneration: 0,
        queue: Promise.resolve(),
        cwd,
        goalModeBlocked: false,
        skills: [],
      };
      this.sessions.set(input.sessionId, entry);
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
      // Skills load async: refresh the command list once discovery lands.
      void listSkillCommands(cwd).then(
        (skills) => {
          if (this.sessions.get(input.sessionId) !== entry || !skills.length)
            return;
          entry.skills = skills;
          this.emitConfig(input.sessionId, entry);
        },
        () => {},
      );
      if (input.history === "replay")
        for (const { item, timestamp } of native.historyItems())
          this.emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: entry.timeline.replay(item),
            timestamp,
          });
      entry.unsubscribe = native.subscribe((event) =>
        this.accept(input.sessionId, entry, event),
      );
      entry.unsubscribeFailure = host.onFailure((error) =>
        native!.runtimeFailed(error),
      );
      if (!this.sessions.has(input.sessionId))
        throw new AdapterError(
          "NATIVE_EXITED",
          "ZCode disconnected during session open",
        );
      for (const request of native.getPendingPermissions())
        this.emit({
          type: "session.permission",
          sessionId: input.sessionId,
          request,
        });
      this.emit({
        type: "session.ready",
        requestId: input.requestId,
        sessionId: input.sessionId,
      });
    } catch (error) {
      this.sessions.delete(input.sessionId);
      try {
        await native?.close();
      } finally {
        this.hosts.delete(host);
        await host.close();
      }
      throw error;
    }
  }

  private emitConfig(id: string, entry: SessionEntry): void {
    const nativeCommands = entry.native.listCommands();
    const commands = nativeCommands.some((c) => c.name === "goal")
      ? nativeCommands
      : [
          ...nativeCommands,
          {
            name: "goal",
            description:
              "Autonomous goal loop on ZCode's official engine (plugin loop as fallback): decompose → rounds → verification (subcommands: status, pause, resume, stop)",
            argumentHint: "<objective> | status | pause | resume | stop",
          },
          {
            name: "auto",
            description: "Alias of /goal",
            argumentHint: "<objective> | status | pause | resume | stop",
          },
        ];
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

  // ---------- goal loop (/goal, /auto) ----------

  private goalNote(sessionId: string, message: string): void {
    this.emit({
      type: "timeline.item",
      sessionId,
      item: {
        id: `zcode:goal-note-${++goalNoteSeq}`,
        type: "assistant_message",
        text: message,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private async handleGoalCommand(
    input: Extract<ProviderInput, { type: "session.prompt" }>,
    entry: SessionEntry,
    label: "goal" | "auto",
    arg: string,
  ): Promise<void> {
    const sessionId = input.sessionId;
    const clientMessageId = input.prompt.clientMessageId;
    // Control-command feedback renders as a synthetic assistant message (the
    // bridge did the same over ACP): notifications are not reliably persisted.
    const note = (message: string): void =>
      this.goalNote(sessionId, message);
    // Completes a non-loop-start command: optional note + prompt_result.
    const complete = (message?: string): void => {
      if (message) note(message);
      if (clientMessageId) {
        entry.messages.set(clientMessageId, true);
        this.emit({
          type: "session.prompt_result",
          sessionId,
          clientMessageId,
          result: { type: "completed" },
        });
      }
    };

    const live = this.goalLoops.get(entry.native.id);
    const sub = arg.split(/\s+/)[0]?.toLowerCase() ?? "";
    // Official ZCode goal mode: the runtime owns the loop engine and the goal
    // state in the conversation snapshot; this adapter is the only protocol
    // seam. Starts go through startTurn (kind "goal") so the Paseo run
    // lifecycle tracks the starting turn — the stop button can then interrupt
    // it, which the runtime turns into a goal pause.
    const adapter = new GoalModeAdapter({
      sendGoal: async (payload) => {
        try {
          await entry.native.startTurn(String(payload.text ?? ""), {
            clientMessageId,
            beforeSend: async () => {
              if (!entry.submitted) {
                await this.persistenceStore.save(
                  entry.persistence,
                  entry.native.id,
                );
                entry.submitted = true;
              }
            },
            kind: "goal",
          });
          return { engaged: true };
        } catch (e) {
          if (!(e instanceof AdapterError)) throw e;
          if (e.code !== "NATIVE_INPUT_REJECTED") throw e;
          // Only a goal-specific refusal proves the runtime rejects official
          // goal mode (sticky fallback); stale/failed acks are transient and
          // must not block future official attempts.
          const goalRefusal = /^ZCode rejected the goal command \((.+)\)$/.exec(
            e.message,
          );
          return {
            engaged: false,
            reasonCode: goalRefusal?.[1] ?? "transient",
          };
        }
      },
      sendAction: (type) => entry.native.sendGoalAction(type),
      snapshot: () => entry.native.goalSnapshot(),
    });
    const route = routeGoalCommand(sub, {
      officialGoal: adapter.state(),
      officialUsable: !entry.goalModeBlocked,
      driverRunning: live?.running === true,
      driverStateSaved: Boolean(readGoalState(entry.cwd, entry.native.id)),
    });
    switch (route.kind) {
      case "official-status": {
        const view = adapter.state();
        complete(view ? formatGoalStatus(view) : `No ${label} loop for this session.`);
        return;
      }
      case "official-pause":
      case "official-resume":
      case "official-stop":
        try {
          if (route.kind === "official-pause")
            complete(await adapter.pause());
          else if (route.kind === "official-resume")
            complete(await adapter.resume());
          else
            // Official goals cannot be cleared, only paused or superseded.
            complete(
              `${await adapter.pause()}\nOfficial goals can't be cleared — start a new ${label} with a fresh objective to supersede this one.`,
            );
        } catch (e) {
          complete(
            `goal control failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return;
      case "driver-status":
        if (live) complete(live.statusText());
        else {
          const prior = readGoalState(entry.cwd, entry.native.id);
          complete(prior ? statusTextOf(prior) : `No ${label} loop for this session.`);
        }
        return;
      case "driver-pause":
        if (live?.running) {
          live.pause();
          complete(`${label} pause requested — takes effect at the round boundary`);
        } else complete(`No running ${label} loop to pause.`);
        return;
      case "driver-resume":
        if (live) {
          live.resume();
          complete(`${label} resume — pause/stop flags cleared, loop continues`);
          return;
        }
        try {
          await this.startGoalLoop(sessionId, entry, "", { resume: true });
        } catch (e) {
          complete(
            `resume failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
        complete(`${label} loop resumed — running detached; rounds stream below.`);
        return;
      case "driver-stop":
        if (live?.running) {
          live.stop();
          complete(`${label} stop requested — ends at the round boundary`);
        } else {
          clearGoalState(entry.cwd, entry.native.id);
          complete(`No running ${label} loop — saved state cleared.`);
        }
        return;
      case "start-official":
        if (entry.native.hasActiveTurn()) {
          complete(
            "ZCode is busy — start the goal once the current turn finishes.",
          );
          return;
        }
        try {
          await adapter.startObjective(arg, {});
        } catch (e) {
          if (e instanceof GoalModeUnavailableError) {
            if (e.reasonCode !== "transient") entry.goalModeBlocked = true;
            note(
              `Official goal mode unavailable (${e.reasonCode}) — using the plugin goal loop.`,
            );
            await this.startGoalLoop(sessionId, entry, arg);
            complete();
            return;
          }
          complete(
            `goal failed to start: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
        note(
          "Official goal engaged — the ZCode runtime drives the loop; iterations and verifications stream below.",
        );
        return;
      case "start-driver":
        try {
          await this.startGoalLoop(sessionId, entry, arg);
        } catch (e) {
          complete(
            `goal loop failed to start: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
        // Complete immediately — Paseo's run-start gate times a prompt out
        // after 60 s without a prompt_result. The loop runs detached from
        // here; its rounds are real native turns that stream into the timeline.
        complete();
        return;
      case "reject": {
        const extra = live?.running ? ` — ${live.statusText()}` : "";
        complete(`${route.reason}${extra}`);
        return;
      }
      case "note":
        complete(route.message);
        return;
    }
  }

  private async startGoalLoop(
    sessionId: string,
    entry: SessionEntry,
    objective: string,
    opts: { resume?: boolean } = {},
  ): Promise<void> {
    const native = entry.native;
    // The /goal prompt bypasses startTurn's beforeSend, so the logical→native
    // mapping must be saved here — without it a daemon/plugin restart loses
    // the session resume and orphans the goal state on disk.
    await this.persistenceStore.save(entry.persistence, native.id);
    const host: GoalLoopHost = {
      cwd: entry.cwd,
      nativeSessionId: native.id,
      runTurn: (prompt) => runDriverTurn(native, prompt),
      announce: (message) => this.goalNote(sessionId, message),
    };
    const driver = GoalLoopDriver.start(host, objective, { resume: opts.resume });
    this.goalLoops.set(native.id, driver);
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
      case "turn_completed":
      case "turn_canceled":
        this.emit({
          type: "session.turn",
          sessionId: id,
          turnId: event.turnId,
          state: event.type === "turn_completed" ? "completed" : "canceled",
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
              message: "ZCode turn failed",
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
    const driver = this.goalLoops.get(entry.native.id);
    if (driver) {
      this.goalLoops.delete(entry.native.id);
      driver.stop();
    }
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
      "ZCode runtime is not set up. Install it in Settings → Plugins → zcode-provider → Settings → Runtime.",
    AUTH_REQUIRED:
      "No ZCode model provider is usable. Sign in or add a provider in Settings → Plugins → zcode-provider → Settings → Account.",
    PERSISTENCE_VERSION_UNSUPPORTED:
      "ZCode persistence version is unsupported. Create a new Paseo ZCode session.",
    PERSISTENCE_INVALID:
      "ZCode resume information is unreadable or invalid. No replacement conversation was created.",
    PERSISTENCE_WRITE_FAILED:
      "ZCode resume information could not be saved. The prompt was not sent.",
  };
  return {
    diagnostic: formatDiagnostic(error),
    code: error instanceof AdapterError ? error.code : "INVALID_CONFIGURATION",
    message:
      error instanceof AdapterError
        ? (messages[error.code] ?? `ZCode operation failed (${error.code})`)
        : "Invalid ZCode provider request",
  };
}

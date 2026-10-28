import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderPersistence } from "@getpaseo/plugin/server/provider";
import { AdapterError } from "./errors.js";

const workspace = z.string().min(1);
const dataSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("logical"), id: z.uuid(), cwd: workspace })
    .strict(),
  z
    .object({
      kind: z.literal("native"),
      sessionId: z.string().min(1),
      cwd: workspace,
    })
    .strict(),
]);
const recordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    cwd: workspace,
  })
  .strict();
// Resume index: lets a fresh provider instance re-open a session it has no
// in-memory state for (dispatch-miss self-heal after adapter process death).
// Deliberately stores no mode/settings (ADR-0014: never infer or duplicate
// setting values) — a resumed native session carries its own.
const indexSchema = z
  .object({
    version: z.literal(1),
    handle: dataSchema,
    config: z
      .object({
        cwd: workspace,
        env: z.record(z.string(), z.string()).optional(),
        model: z.string().optional(),
        thinkingOption: z.string().optional(),
        mcpServers: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
  })
  .strict();
export type PersistenceData = z.infer<typeof dataSchema>;
export type ResumeIndexRecord = z.infer<typeof indexSchema>;

export function parsePersistence(handle: ProviderPersistence): PersistenceData {
  if (handle.version !== 3)
    throw new AdapterError(
      "PERSISTENCE_VERSION_UNSUPPORTED",
      "Unsupported ZCode persistence version; expected version 3",
    );
  try {
    return dataSchema.parse(handle.data);
  } catch {
    throw new AdapterError(
      "PERSISTENCE_INVALID",
      "Invalid ZCode persistence handle",
    );
  }
}

export function persistenceHandle(data: PersistenceData): ProviderPersistence {
  return { version: 3, data };
}

// Outside the plugin checkout: reinstalling/building the plugin must not erase handles.
export function defaultSessionDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "paseo-plugin-zcode-provider",
    "sessions-v3",
  );
}

export class SessionPersistenceStore {
  private readonly indexDirectory: string;

  constructor(readonly directory: string = defaultSessionDirectory()) {
    this.indexDirectory = join(directory, "index");
  }

  private filename(id: string): string {
    return join(this.directory, `${z.uuid().parse(id)}.json`);
  }

  private indexFilename(publicSessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(publicSessionId))
      throw new AdapterError(
        "PERSISTENCE_INVALID",
        "Invalid session id for the resume index",
      );
    return join(this.indexDirectory, `${publicSessionId}.json`);
  }

  async saveIndex(
    publicSessionId: string,
    record: ResumeIndexRecord,
  ): Promise<void> {
    try {
      await mkdir(this.indexDirectory, { recursive: true, mode: 0o700 });
      await this.atomicWrite(
        this.indexFilename(publicSessionId),
        indexSchema.parse(record),
      );
    } catch (error) {
      throw new AdapterError(
        "PERSISTENCE_WRITE_FAILED",
        "Cannot save the ZCode resume index",
        {},
        { cause: error },
      );
    }
  }

  async loadIndex(
    publicSessionId: string,
  ): Promise<ResumeIndexRecord | undefined> {
    let content: string;
    try {
      content = await readFile(this.indexFilename(publicSessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AdapterError(
        "PERSISTENCE_INVALID",
        "Cannot read the ZCode resume index",
        {},
        { cause: error },
      );
    }
    try {
      return indexSchema.parse(JSON.parse(content));
    } catch (error) {
      throw new AdapterError(
        "PERSISTENCE_INVALID",
        "Invalid ZCode resume index record",
        {},
        { cause: error },
      );
    }
  }

  async deleteIndex(publicSessionId: string): Promise<void> {
    await rm(this.indexFilename(publicSessionId), { force: true });
  }

  async resolve(data: PersistenceData): Promise<string | undefined> {
    if (data.kind === "native") return data.sessionId;
    let content: string;
    try {
      content = await readFile(this.filename(data.id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AdapterError(
        "PERSISTENCE_INVALID",
        "Cannot read ZCode persistence record",
        {},
        { cause: error },
      );
    }
    let record: z.infer<typeof recordSchema>;
    try {
      record = recordSchema.parse(JSON.parse(content));
    } catch (error) {
      throw new AdapterError(
        "PERSISTENCE_INVALID",
        "Invalid ZCode persistence record",
        {},
        { cause: error },
      );
    }
    if (record.cwd !== data.cwd)
      throw new AdapterError(
        "INVALID_WORKSPACE",
        "ZCode persistence belongs to another workspace",
      );
    return record.sessionId;
  }

  async save(data: PersistenceData, sessionId: string): Promise<void> {
    if (data.kind === "native") return;
    const record = recordSchema.parse({ version: 1, sessionId, cwd: data.cwd });
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.atomicWrite(this.filename(data.id), record);
    } catch (error) {
      throw new AdapterError(
        "PERSISTENCE_WRITE_FAILED",
        "Cannot save ZCode resume information; prompt was not sent",
        {},
        { cause: error },
      );
    }
  }

  private async atomicWrite(
    destination: string,
    value: unknown,
  ): Promise<void> {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      // Windows does not support opening directories for fsync.
      if (process.platform !== "win32") {
        const directory = await open(dirname(destination), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

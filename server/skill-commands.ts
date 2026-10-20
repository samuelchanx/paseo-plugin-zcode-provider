import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ZCode's protocol slash-command list covers builtins and .md custom commands
 * only — skills (SKILL.md directories) never reach it, so Paseo's slash
 * autocomplete shows none of them. This module mirrors the runtime's own skill
 * discovery (user `~/.zcode|~/.agents` skills, then the project chain up to the
 * worktree root, first name wins) so the provider can report skills as
 * commands. Results are cached briefly: the list is also consulted on every
 * command-typed prompt.
 */

export interface SkillCommand {
  name: string;
  description: string;
}

const SKILLS_DIR = "skills";
const ZCODE_DIR = ".zcode";
const AGENTS_DIR = ".agents";
const CACHE_TTL_MS = 10_000;

const cache = new Map<string, { at: number; skills: SkillCommand[] }>();

export function resetSkillCommandCacheForTests(): void {
  cache.clear();
}

export function mergeSkillCommands(
  native: { name: string }[],
  reserved: string[],
  skills: SkillCommand[],
): SkillCommand[] {
  const taken = new Set([...reserved, ...native.map((c) => c.name)]);
  return skills.filter((skill) => !taken.has(skill.name));
}

function parseFrontmatterField(
  content: string,
  field: "name" | "description",
): string | undefined {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return undefined;
  const lines = normalized.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end <= 0) return undefined;
  for (const line of lines.slice(1, end)) {
    const match = new RegExp(`^${field}:\\s*(.+?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

async function readSkillDir(root: string): Promise<SkillCommand[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: SkillCommand[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      isDir = await stat(join(root, entry.name))
        .then((info) => info.isDirectory())
        .catch(() => false);
    }
    if (!isDir) continue;
    const content = await readFile(join(root, entry.name, "SKILL.md"), "utf8").catch(
      () => undefined,
    );
    if (content === undefined) continue;
    found.push({
      name: parseFrontmatterField(content, "name") ?? entry.name,
      description: parseFrontmatterField(content, "description") ?? "",
    });
  }
  return found;
}

async function findWorktreeRoot(directory: string): Promise<string | null> {
  let current = directory;
  for (;;) {
    if (
      await stat(join(current, ".git"))
        .then(() => true)
        .catch(() => false)
    )
      return current;
    const parent = join(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

async function discover(cwd: string, home: string): Promise<SkillCommand[]> {
  const selected = new Map<string, SkillCommand>();
  // User scope first: ZCode's own enumeration lets user skills shadow project
  // and plugin copies of the same name.
  const userRoots = [
    join(home, ZCODE_DIR, SKILLS_DIR),
    join(home, AGENTS_DIR, SKILLS_DIR),
  ];
  const projectRoots: string[] = [];
  let current = cwd;
  for (;;) {
    projectRoots.push(
      join(current, ZCODE_DIR, SKILLS_DIR),
      join(current, AGENTS_DIR, SKILLS_DIR),
    );
    const worktreeRoot = await findWorktreeRoot(current);
    if (!worktreeRoot || current === worktreeRoot) break;
    current = worktreeRoot;
  }
  for (const root of [...userRoots, ...projectRoots]) {
    for (const skill of await readSkillDir(root)) {
      if (!selected.has(skill.name)) selected.set(skill.name, skill);
    }
  }
  return [...selected.values()];
}

export async function listSkillCommands(
  cwd: string,
  home: string = homedir(),
): Promise<SkillCommand[]> {
  const key = `${home}\u0000${cwd}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.skills;
  const skills = await discover(cwd, home);
  cache.set(key, { at: Date.now(), skills });
  return skills;
}

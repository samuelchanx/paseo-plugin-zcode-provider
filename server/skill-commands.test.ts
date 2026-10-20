import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listSkillCommands,
  mergeSkillCommands,
  resetSkillCommandCacheForTests,
} from "./skill-commands.js";

const dirs: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-commands-"));
  dirs.push(dir);
  return dir;
}

async function skill(
  root: string,
  name: string,
  frontmatter?: { name?: string; description?: string },
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const lines = ["---"];
  if (frontmatter?.name) lines.push(`name: ${frontmatter.name}`);
  if (frontmatter?.description)
    lines.push(`description: ${frontmatter.description}`);
  lines.push("---", "", "Body.");
  await writeFile(join(dir, "SKILL.md"), lines.join("\n"));
}

afterEach(async () => {
  resetSkillCommandCacheForTests();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("listSkillCommands", () => {
  it("discovers skills with frontmatter name/description and dir-name fallback", async () => {
    const home = await makeRoot();
    await skill(join(home, ".agents", "skills"), "to-prd", {
      description: "Turn an idea into a PRD",
    });
    await skill(join(home, ".zcode", "skills"), "trade-chart");
    const skills = await listSkillCommands("/nowhere", home);
    expect(skills).toEqual([
      { name: "trade-chart", description: "" },
      { name: "to-prd", description: "Turn an idea into a PRD" },
    ]);
  });

  it("lets the nearest project directory override farther ones but keeps user precedence over project", async () => {
    const home = await makeRoot();
    const repo = await makeRoot();
    const sub = join(repo, "pkg");
    await mkdir(sub, { recursive: true });
    await mkdir(join(repo, ".git"));
    await skill(join(home, ".agents", "skills"), "deploy", {
      description: "user copy",
    });
    await skill(join(repo, ".agents", "skills"), "deploy", {
      description: "repo copy",
    });
    await skill(join(repo, ".agents", "skills"), "lint-only-here", {
      description: "project skill",
    });
    const skills = await listSkillCommands(sub, home);
    const byName = new Map(skills.map((s) => [s.name, s.description]));
    expect(byName.get("deploy")).toBe("user copy");
    expect(byName.get("lint-only-here")).toBe("project skill");
  });

  it("ignores directories without SKILL.md, files, and hidden entries", async () => {
    const home = await makeRoot();
    const agents = join(home, ".agents", "skills");
    await skill(agents, "real");
    await mkdir(join(agents, "no-skill-file"));
    await writeFile(join(agents, "loose-file.md"), "not a skill");
    await mkdir(join(agents, ".hidden"));
    const skills = await listSkillCommands("/nowhere", home);
    expect(skills).toEqual([{ name: "real", description: "" }]);
  });

  it("caches results until the cache is reset", async () => {
    const home = await makeRoot();
    const agents = join(home, ".agents", "skills");
    await skill(agents, "first");
    expect((await listSkillCommands("/nowhere", home)).map((s) => s.name)).toEqual([
      "first",
    ]);
    await skill(agents, "second");
    expect((await listSkillCommands("/nowhere", home)).map((s) => s.name)).toEqual([
      "first",
    ]);
    resetSkillCommandCacheForTests();
    expect((await listSkillCommands("/nowhere", home)).map((s) => s.name)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("mergeSkillCommands", () => {
  it("skills skip native command names and reserved names, order preserved", () => {
    const merged = mergeSkillCommands(
      [{ name: "compact" }, { name: "model" }],
      ["goal", "auto"],
      [
        { name: "to-prd", description: "prd" },
        { name: "model", description: "collides with native" },
        { name: "goal", description: "reserved" },
        { name: "to-goal", description: "goal alias" },
      ],
    );
    expect(merged).toEqual([
      { name: "to-prd", description: "prd" },
      { name: "to-goal", description: "goal alias" },
    ]);
  });
});

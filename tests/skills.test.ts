import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeMethodNamesFromSession, getAgentSkill, listActiveMethods, listAgentSkills } from "../src/skills.js";
import type { PlannerTask } from "../src/types.js";

test("Pi extension state adapter observes generic enabled method entries", () => {
  assert.deepEqual(activeMethodNamesFromSession([
    { type: "custom", customType: "design-thinking-state", data: { enabled: true } },
    { type: "custom", customType: "other-state", data: { enabled: false } },
    { type: "message", customType: "ignored", data: { enabled: true } }
  ]), ["design-thinking"]);
});

test("task snapshot exposes active method without environment or workspace toggle", async () => {
  const workspace = await mkdtemp(join("/tmp", "pi-method-"));
  try {
    const task = { workspaceRoot: workspace, activeMethods: ["design-thinking"] } as PlannerTask;
    assert.equal((await listActiveMethods(task))[0]?.name, "design-thinking");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("skill/method bridge lists metadata and fetches bounded content read-only", async () => {
  const workspace = await mkdtemp(join("/tmp", "pi-skills-"));
  const old = process.env.PI_ACTIVE_METHODS;
  try {
    await mkdir(join(workspace, ".pi", "skills", "testing"), { recursive: true });
    await mkdir(join(workspace, ".pi", "methods", "design-thinking"), { recursive: true });
    await writeFile(join(workspace, ".pi", "skills", "testing", "SKILL.md"), "---\nname: testing\ndescription: Test-first work\n---\nInstructions", "utf8");
    await writeFile(join(workspace, ".pi", "methods", "design-thinking", "METHOD.md"), "---\nname: design-thinking\ndescription: Explore before building\n---\nMethod instructions", "utf8");
    process.env.PI_ACTIVE_METHODS = "design-thinking";
    const task = { workspaceRoot: workspace } as PlannerTask;
    const skills = await listAgentSkills(task);
    assert.equal(skills.some((skill) => skill.name === "testing"), true);
    assert.equal((await listActiveMethods(task)).map((method) => method.name).includes("design-thinking"), true);
    const content = await getAgentSkill(task, "testing");
    assert.match(content.content, /Instructions/);
    assert.equal((await listActiveMethods(task)).some((method) => method.name === "inactive"), false);
  } finally {
    if (old === undefined) delete process.env.PI_ACTIVE_METHODS; else process.env.PI_ACTIVE_METHODS = old;
    await rm(workspace, { recursive: true, force: true });
  }
});

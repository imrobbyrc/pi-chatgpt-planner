import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { PlannerTask } from "./types.js";

export interface AgentResource { name: string; source: string; description: string; scope: "workspace" | "user"; active: boolean; phases: string[]; path: string; }

const roots = (workspace: string, kind: "skills" | "methods") => [
  { path: join(workspace, ".pi", kind), scope: "workspace" as const },
  { path: join(workspace, ".agents", kind), scope: "workspace" as const },
  { path: join(workspace, ".claude", kind), scope: "workspace" as const },
  { path: join(workspace, "skills"), scope: "workspace" as const, onlySkills: true },
  { path: join(homedir(), ".pi", "agent", kind), scope: "user" as const },
  { path: join(homedir(), ".agents", kind), scope: "user" as const },
  { path: join(homedir(), ".pi", kind), scope: "user" as const }
];

function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

async function metadata(path: string, scope: AgentResource["scope"], active: boolean, file?: string): Promise<AgentResource> {
  const contentPath = file ?? join(path, "SKILL.md");
  const name = file && file === path ? (file.split("/").at(-1) ?? file).replace(/\.md$/i, "") : path.split("/").at(-1) ?? path;
  let description = ""; let phases = ["planning", "execution", "review"];
  try {
    const text = (await readFile(contentPath, "utf8")).slice(0, 12_000);
    description = text.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? text.split("\n").find((line) => line.trim() && !line.startsWith("#") && !line.startsWith("---"))?.trim() ?? "";
    const phase = text.match(/^phases:\s*(.+)$/m)?.[1]; if (phase) phases = phase.split(",").map((x) => x.trim()).filter(Boolean);
  } catch { /* optional resource */ }
  return { name, source: path, description: description.slice(0, 240), scope, active, phases, path: contentPath };
}

export function activeMethodNamesFromSession(entries: readonly { type?: string; customType?: string; data?: unknown }[]): string[] {
  return [...new Set(entries.flatMap((entry) => {
    if (entry.type !== "custom" || !entry.customType?.endsWith("-state")) return [];
    return (entry.data as { enabled?: unknown } | undefined)?.enabled === true ? [entry.customType.slice(0, -6)] : [];
  }))];
}

async function activeMethodNames(workspace: string): Promise<string[]> {
  const names = (process.env.PI_ACTIVE_METHODS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  try {
    const value = JSON.parse(await readFile(join(workspace, ".pi", "active-methods.json"), "utf8"));
    if (Array.isArray(value)) names.push(...value.filter((x): x is string => typeof x === "string"));
  } catch { /* no persisted method toggle */ }
  return [...new Set(names)];
}

async function discover(task: PlannerTask, kind: "skills" | "methods"): Promise<AgentResource[]> {
  const activeNames = kind === "methods" ? await activeMethodNames(task.workspaceRoot) : [];
  const result: AgentResource[] = [];
  async function walk(root: { path: string; scope: AgentResource["scope"]; onlySkills?: boolean }, path: string, depth: number): Promise<void> {
    if (depth > 4 || (root.onlySkills && kind !== "skills")) return;
    try {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (!inside(child, root.path)) continue;
        if (entry.isDirectory()) {
          const content = kind === "methods" ? join(child, "METHOD.md") : join(child, "SKILL.md");
          try { await readFile(content, "utf8"); result.push(await metadata(child, root.scope, activeNames.includes(entry.name), content)); }
          catch { await walk(root, child, depth + 1); }
        } else if (kind === "skills" && entry.name.endsWith(".md") && path === root.path) {
          result.push(await metadata(child, root.scope, false, child));
        }
      }
    } catch { /* absent optional roots are normal */ }
  }
  for (const root of roots(task.workspaceRoot, kind)) await walk(root, root.path, 0);
  return result.filter((resource, index, all) => all.findIndex((item) => item.name === resource.name && item.scope === resource.scope) === index);
}

async function discoverPiSkills(task: PlannerTask): Promise<AgentResource[]> {
  try {
    const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
    const loader = new DefaultResourceLoader({ cwd: task.workspaceRoot, agentDir: join(homedir(), ".pi", "agent"), noExtensions: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    return Promise.all(loader.getSkills().skills.map((skill) => metadata(skill.baseDir, skill.sourceInfo.scope === "project" ? "workspace" : "user", false, skill.filePath)));
  } catch { return []; }
}

export async function listAgentSkills(task: PlannerTask): Promise<AgentResource[]> {
  const resources = [...await discoverPiSkills(task), ...await discover(task, "skills")];
  return resources.filter((resource, index, all) => all.findIndex((item) => item.name === resource.name && item.scope === resource.scope) === index);
}
export async function listActiveMethods(task: PlannerTask): Promise<AgentResource[]> {
  const discovered = await discover(task, "methods");
  const active = new Set([...(task.activeMethods ?? []), ...await activeMethodNames(task.workspaceRoot)]);
  return [...active].map((name) => discovered.find((method) => method.name === name) ?? {
    name, source: "pi-session", description: "Active Pi extension method.", scope: "user" as const,
    active: true, phases: ["planning", "execution", "review"], path: ""
  });
}

export async function getAgentSkill(task: PlannerTask, name: string, kind: "skills" | "methods" = "skills"): Promise<{ metadata: AgentResource; content: string }> {
  let resource = (await discover(task, kind)).find((item) => item.name === name);
  if (!resource && kind === "methods" && (task.activeMethods ?? []).includes(name)) {
    const skills = await discoverPiSkills(task);
    resource = skills.find((skill) => skill.name === name || skill.name === `${name.split("-")[0]}-method`);
  }
  if (!resource || !resource.path) throw new Error(`Unknown ${kind.slice(0, -1)} "${name}".`);
  return { metadata: resource, content: (await readFile(resource.path, "utf8")).slice(0, 40_000) };
}

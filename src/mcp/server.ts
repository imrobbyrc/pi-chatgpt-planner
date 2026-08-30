import Fastify, { type FastifyInstance } from "fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { PlannerConfig } from "../types.js";
import { TaskStore } from "../task-store.js";
import { gitBranch, gitDiff, gitStatus } from "../workspace/git.js";
import { listDirectory, readTextFile, repoMap } from "../workspace/files.js";
import { searchWorkspace } from "../workspace/search.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export function createPlannerMcpFactory(store: TaskStore, config: PlannerConfig) {
  return () => {
    const server = new McpServer({ name: "pi-chatgpt-planner", version: "0.0.1" });

    server.registerTool(
      "workspace_info",
      {
        title: "Workspace info",
        description: "Return metadata for the Pi workspace attached to a planning task.",
        inputSchema: z.object({ task_id: z.string().uuid() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id }) => {
        const task = await store.getTask(task_id);
        let branch = "";
        try {
          branch = await gitBranch(task.workspaceRoot);
        } catch {
          branch = "(not a git repository)";
        }
        return text({
          task_id: task.id,
          request: task.request,
          workspace_root: task.workspaceRoot,
          git_branch: branch,
          status: task.status
        });
      }
    );

    server.registerTool(
      "repo_map",
      {
        title: "Repository map",
        description: "Return a bounded directory tree for the task workspace.",
        inputSchema: z.object({
          task_id: z.string().uuid(),
          max_depth: z.number().int().min(1).max(6).optional()
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id, max_depth }) => {
        const task = await store.getTask(task_id);
        return text(await repoMap(task.workspaceRoot, max_depth ?? 3));
      }
    );

    server.registerTool(
      "list_directory",
      {
        title: "List directory",
        description: "List one directory inside the task workspace. Paths are workspace-relative.",
        inputSchema: z.object({
          task_id: z.string().uuid(),
          path: z.string().default(".")
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id, path }) => {
        const task = await store.getTask(task_id);
        return text((await listDirectory(task.workspaceRoot, path)).join("\n"));
      }
    );

    server.registerTool(
      "read_file",
      {
        title: "Read file",
        description: "Read a bounded line range from a UTF-8 text file inside the task workspace.",
        inputSchema: z.object({
          task_id: z.string().uuid(),
          path: z.string().min(1),
          start_line: z.number().int().positive().optional(),
          end_line: z.number().int().positive().optional()
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id, path, start_line, end_line }) => {
        const task = await store.getTask(task_id);
        return text(
          await readTextFile(
            task.workspaceRoot,
            path,
            config,
            start_line ?? 1,
            end_line
          )
        );
      }
    );

    server.registerTool(
      "search_workspace",
      {
        title: "Search workspace",
        description: "Search text in the task workspace using ripgrep when available, with a safe JS fallback.",
        inputSchema: z.object({
          task_id: z.string().uuid(),
          query: z.string().min(1),
          glob: z.string().optional(),
          max_results: z.number().int().min(1).max(200).optional()
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id, query, glob, max_results }) => {
        const task = await store.getTask(task_id);
        return text(await searchWorkspace(task.workspaceRoot, query, max_results ?? 50, glob));
      }
    );

    server.registerTool(
      "git_status",
      {
        title: "Git status",
        description: "Read git status for the task workspace.",
        inputSchema: z.object({ task_id: z.string().uuid() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id }) => {
        const task = await store.getTask(task_id);
        return text(await gitStatus(task.workspaceRoot));
      }
    );

    server.registerTool(
      "git_diff",
      {
        title: "Git diff",
        description: "Read the current git diff for the task workspace. Intended for the later review loop.",
        inputSchema: z.object({
          task_id: z.string().uuid(),
          staged: z.boolean().optional()
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id, staged }) => {
        const task = await store.getTask(task_id);
        return text(await gitDiff(task.workspaceRoot, staged ?? false));
      }
    );

    server.registerTool(
      "submit_plan",
      {
        title: "Submit external plan",
        description:
          "Submit the final structured planning result for a Pi task. This writes only planner protocol state; it never edits source files or runs commands.",
        inputSchema: z.object({
          task_id: z.string().uuid(),
          summary: z.string().min(1),
          plan_markdown: z.string().min(1),
          files_to_inspect: z.array(z.string()).default([]),
          acceptance_criteria: z.array(z.string()).default([]),
          tests: z.array(z.string()).default([]),
          risks: z.array(z.string()).default([]),
          open_questions: z.array(z.string()).default([])
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async ({
        task_id,
        summary,
        plan_markdown,
        files_to_inspect,
        acceptance_criteria,
        tests,
        risks,
        open_questions
      }) => {
        const task = await store.submitPlan(task_id, {
          summary,
          planMarkdown: plan_markdown,
          filesToInspect: files_to_inspect,
          acceptanceCriteria: acceptance_criteria,
          tests,
          risks,
          openQuestions: open_questions
        });
        return text({ ok: true, task_id: task.id, status: task.status });
      }
    );

    return server;
  };
}

export class PlannerMcpHttpServer {
  private app: FastifyInstance | undefined;

  constructor(
    private readonly store: TaskStore,
    private readonly config: PlannerConfig
  ) {}

  get localUrl(): string {
    return `http://${this.config.mcpHost}:${this.config.mcpPort}${this.config.mcpPath}`;
  }

  async start(): Promise<void> {
    if (this.app) return;
    await this.store.init();

    const handler = createMcpHandler(createPlannerMcpFactory(this.store, this.config));
    const nodeHandler = toNodeHandler(handler);
    const app = Fastify({ logger: false });

    app.get("/healthz", async () => ({ ok: true, name: "pi-chatgpt-planner" }));
    app.all(this.config.mcpPath, async (request, reply) => {
      return nodeHandler(request.raw as NodeIncomingMessageLike, reply.raw, request.body);
    });

    await app.listen({ host: this.config.mcpHost, port: this.config.mcpPort });
    this.app = app;
  }

  get running(): boolean { return this.app !== undefined; }

  async stop(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    if (app) await app.close();
  }
}

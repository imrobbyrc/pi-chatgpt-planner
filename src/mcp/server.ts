import Fastify, { type FastifyInstance } from "fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { PlannerConfig } from "../types.js";
import { TaskStore } from "../task-store.js";
import { gitBranch, gitDiff, gitStatus } from "../workspace/git.js";
import { listDirectory, readTextFile, repoMap } from "../workspace/files.js";
import { searchWorkspace } from "../workspace/search.js";
import { getAgentSkill, listActiveMethods, listAgentSkills } from "../skills.js";

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
          status: task.status,
          capabilities: ["submit_plan", "submit_plan_revision", "review_context", "submit_review", "test_status", "list_agent_skills", "get_agent_skill", "list_active_methods", "get_method_context"]
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
      "list_agent_skills",
      {
        title: "List agent skills",
        description: "Read-only metadata for Pi-discovered skills. Full content is fetched separately and bounded.",
        inputSchema: z.object({ task_id: z.string().uuid() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id }) => text((await listAgentSkills(await store.getTask(task_id))).map(({ path: _path, ...item }) => item))
    );

    server.registerTool(
      "get_agent_skill",
      {
        title: "Get agent skill",
        description: "Read-only bounded content for one Pi skill or method; never executes it.",
        inputSchema: z.object({ task_id: z.string().uuid(), name: z.string().min(1), kind: z.enum(["skills", "methods"]).default("skills") }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id, name, kind }) => {
        const value = await getAgentSkill(await store.getTask(task_id), name, kind);
        return text({ metadata: { ...value.metadata, path: undefined }, content: value.content });
      }
    );

    server.registerTool(
      "list_active_methods",
      {
        title: "List active methods",
        description: "Read-only Pi/user-controlled active planning methods. ChatGPT cannot activate methods.",
        inputSchema: z.object({ task_id: z.string().uuid() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id }) => text((await listActiveMethods(await store.getTask(task_id))).map(({ path: _path, ...item }) => item))
    );

    server.registerTool(
      "get_method_context",
      {
        title: "Get method context",
        description: "Read-only bounded instructions for an already-active Pi method.",
        inputSchema: z.object({ task_id: z.string().uuid(), name: z.string().min(1) }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id, name }) => {
        const task = await store.getTask(task_id);
        if (!(await listActiveMethods(task)).some((method) => method.name === name)) throw new Error(`Method "${name}" is not active in Pi.`);
        const value = await getAgentSkill(task, name, "methods");
        return text({ metadata: { ...value.metadata, path: undefined }, content: value.content });
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
          open_questions: z.array(z.string()).default([]),
          context: z.object({ methods: z.array(z.string()).default([]), skills: z.array(z.string()).default([]) }).optional()
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
        open_questions,
        context
      }) => {
        const task = await store.submitPlan(task_id, {
          summary,
          planMarkdown: plan_markdown,
          filesToInspect: files_to_inspect,
          acceptanceCriteria: acceptance_criteria,
          tests,
          risks,
          openQuestions: open_questions,
          ...(context ? { context } : {})
        });
        return text({ ok: true, task_id: task.id, status: task.status });
      }
    );

    server.registerTool(
      "submit_plan_revision",
      {
        title: "Submit plan revision",
        description: "Submit a complete revised plan against the current revision. Writes planner state only; source remains read-only.",
        inputSchema: z.object({
          task_id: z.string().uuid(), base_revision: z.number().int().positive(), feedback: z.string().min(1),
          summary: z.string().min(1), plan_markdown: z.string().min(1), files_to_inspect: z.array(z.string()).default([]),
          acceptance_criteria: z.array(z.string()).default([]), tests: z.array(z.string()).default([]), risks: z.array(z.string()).default([]), open_questions: z.array(z.string()).default([]),
          context: z.object({ methods: z.array(z.string()).default([]), skills: z.array(z.string()).default([]) }).optional()
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async ({ task_id, base_revision, feedback, summary, plan_markdown, files_to_inspect, acceptance_criteria, tests, risks, open_questions, context }) => {
        const task = await store.submitPlanRevision(task_id, base_revision, { summary, planMarkdown: plan_markdown, filesToInspect: files_to_inspect, acceptanceCriteria: acceptance_criteria, tests, risks, openQuestions: open_questions, ...(context ? { context } : {}) }, feedback, context);
        return text({ ok: true, task_id: task.id, status: task.status, revision: task.planRevisions?.currentRevision });
      }
    );

    server.registerTool(
      "review_context",
      {
        title: "Review context",
        description:
          "Read-only review context for a task: request, approved plan, execution evidence, git before/after snapshots, review iteration, and previous findings. Never exposes credentials.",
        inputSchema: z.object({ task_id: z.string().uuid() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id }) => {
        const task = await store.getTask(task_id);
        return text({
          task_id: task.id,
          request: task.request,
          plan: task.plan,
          plan_revisions: task.planRevisions,
          approved_revision: task.planRevisions?.approvedRevision,
          execution: task.execution,
          review: task.review,
          git_evidence: task.gitEvidence
        });
      }
    );

    server.registerTool(
      "test_status",
      {
        title: "Test status",
        description: "Read persisted Pi validation evidence for an executed task. Empty means Pi extension events supplied no authoritative test results; it never claims unobserved tests passed.",
        inputSchema: z.object({ task_id: z.string().uuid() }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      async ({ task_id }) => {
        const task = await store.getTask(task_id);
        return text({ task_id: task.id, validations: task.execution?.validations ?? [], evidence_available: (task.execution?.validations.length ?? 0) > 0 });
      }
    );

    server.registerTool(
      "submit_review",
      {
        title: "Submit review",
        description:
          "Submit the structured review verdict for one review iteration of an executed task. Writes only planner review state; never edits source files.",
        inputSchema: z.object({
          task_id: z.string().uuid(),
          iteration: z.number().int().positive(),
          status: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
          summary: z.string().min(1),
          findings: z.array(z.object({
            severity: z.enum(["blocking", "major", "minor"]),
            file: z.string().optional(),
            line: z.number().int().positive().optional(),
            issue: z.string().min(1),
            requested_change: z.string().optional(),
            scope_expansion_required: z.boolean().default(false)
          })).default([])
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      },
      async ({ task_id, iteration, status, summary, findings }) => {
        const mapped: import("../types.js").ReviewFinding[] = findings.map((finding) => ({ severity: finding.severity, issue: finding.issue, ...(finding.file ? { file: finding.file } : {}), ...(finding.line ? { line: finding.line } : {}), ...(finding.requested_change ? { requested_change: finding.requested_change } : {}), ...(finding.scope_expansion_required ? { scopeExpansionRequired: true } : {}) }));
        const task = await store.saveReviewResult(task_id, iteration, status === "APPROVED" ? "approved" : "changes_requested", summary, mapped);
        return text({ ok: true, task_id: task.id, review_status: task.review?.status, iteration });
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

export type TaskStatus =
  | "planning"
  | "plan_received"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "execution_completed"
  | "execution_failed";

export interface ChatSessionMetadata {
  targetId: string;
  conversationUrl?: string;
  conversationId?: string;
  temporary: boolean;
  personalized: boolean;
  reasoning: "high" | "unknown";
}

export interface PlannerPlan {
  summary: string;
  planMarkdown: string;
  filesToInspect: string[];
  acceptanceCriteria: string[];
  tests: string[];
  risks: string[];
  openQuestions: string[];
  submittedAt: string;
}

export interface ExecutionResult {
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string;
  summary: string;
  filesChanged: string[];
  validations: string[];
  deviations: string[];
  remainingIssues: string[];
  error?: string;
  round?: number; // V2: 0 = initial execution, n = correction round n
}

export interface GitEvidence {
  capturedAt: string;
  gitStatus: string;
  gitDiff: string;
  testStatus?: string;
}

export type ReviewSeverity = "blocking" | "major" | "minor";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  issue: string;
  requested_change?: string;
  scopeExpansionRequired?: boolean;
}

export interface ReviewRecord {
  iteration: number;
  startedAt: string;
  completedAt?: string;
  status: "reviewing" | "approved" | "changes_requested" | "failed";
  summary?: string;
  findings: ReviewFinding[];
  evidence?: GitEvidence;
  correction?: ExecutionResult;
  error?: string;
}

export type ReviewStatus =
  | "not_started"
  | "awaiting_review"
  | "reviewing"
  | "approved"
  | "changes_requested"
  | "correction_executing"
  | "correction_completed"
  | "failed"
  | "max_iterations_reached"
  | "scope_expansion_required";

export interface ReviewError {
  kind: "planner_target_unavailable" | "planner_target_closed" | "infrastructure_not_ready" | "review_timeout" | "browser_transport_failure" | "mcp_unavailable" | "interrupted_review" | "legacy_operational_failure_recovered" | "other";
  message: string;
  occurredAt: string;
}

export interface ReviewState {
  status: ReviewStatus;
  iteration: number; // compatibility/display: current semantic review iteration
  semanticIteration?: number;
  attempt?: number;
  error?: ReviewError;
  reviews: ReviewRecord[];
}

export interface PlannerTask {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  request: string;
  status: TaskStatus;
  chat?: ChatSessionMetadata;
  plan?: PlannerPlan;
  execution?: ExecutionResult;
  review?: ReviewState;
  gitEvidence?: { preExecution?: GitEvidence; postExecution?: GitEvidence };
  error?: string;
}

export interface PlannerConfig {
  mcpHost: string; mcpPort: number; mcpPath: string; publicMcpUrl: string | undefined;
  stateDir: string; browser: "dia" | "chrome"; browserBinary: string | undefined;
  browserProfileDir: string; browserStartupTimeoutMs: number; cdpHost: string; cdpPort: number;
  chatgptUrl: string; chatgptAppName: string; browserAutoAttachApp: boolean;
  planTimeoutMs: number; maxReadLines: number; maxFileBytes: number;
  tunnelBinary: string; tunnelProfile: string; tunnelHealthPort: number; tunnelStartupTimeoutMs: number;
  maxReviewIterations: number; reviewTimeoutMs: number;
}

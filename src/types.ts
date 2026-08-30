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
  error?: string;
}

export interface PlannerConfig {
  mcpHost: string; mcpPort: number; mcpPath: string; publicMcpUrl: string | undefined;
  stateDir: string; browser: "dia" | "chrome"; browserBinary: string | undefined;
  browserProfileDir: string; browserStartupTimeoutMs: number; cdpHost: string; cdpPort: number;
  chatgptUrl: string; chatgptAppName: string; browserAutoAttachApp: boolean;
  planTimeoutMs: number; maxReadLines: number; maxFileBytes: number;
}

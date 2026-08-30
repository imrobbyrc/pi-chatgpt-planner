export type TaskStatus =
  | "pending_planning"
  | "plan_received"
  | "failed"
  | "cancelled";

export interface ChatSessionMetadata {
  targetId: string;
  conversationUrl?: string;
  conversationId?: string;
  temporary: boolean;
  personalized: boolean;
  reasoning: "high" | "unknown";
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
  error?: string;
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

export interface PlannerConfig {
  mcpHost: string;
  mcpPort: number;
  mcpPath: string;
  publicMcpUrl: string | undefined;
  stateDir: string;
  browser: "dia" | "chrome";
  browserBinary: string | undefined;
  browserProfileDir: string;
  browserStartupTimeoutMs: number;
  cdpHost: string;
  cdpPort: number;
  chatgptUrl: string;
  chatgptAppName: string;
  browserAutoAttachApp: boolean;
  planTimeoutMs: number;
  maxReadLines: number;
  maxFileBytes: number;
}

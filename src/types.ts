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

export interface PlannerContext {
  methods: string[];
  skills: string[];
}

export interface PlanRevision {
  revision: number;
  feedback?: string;
  plan: PlannerPlan;
  targetId: string;
  context?: PlannerContext;
  createdAt: string;
}

export interface PlanRevisionState {
  currentRevision: number;
  revisions: PlanRevision[];
  approvedRevision?: number;
  approvedPlanFingerprint?: string;
}

export interface HerdrWorker {
  id: string;
  objective: string;
  owns: string[];
  dependsOn: string[];
}

export interface HerdrExecutionContract {
  mode: "herdr";
  workerModel: "luna-max";
  workers: HerdrWorker[];
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
  execution?: HerdrExecutionContract;
  context?: PlannerContext;
}

export interface WorkspaceBaseline {
  capturedAt: string;
  files: Record<string, string>;
}

export interface ScopeEvidence {
  changedFiles: string[];
  unownedFiles: string[];
  ambiguousOwnerFiles: string[];
  ownersByFile: Record<string, string[]>;
}

export interface HerdrWorkerRecord extends HerdrWorker {
  state: "pending" | "blocked" | "ready" | "starting" | "running" | "completed" | "failed" | "cancelled";
  paneId?: string;
  /** Herdr runtime handle; agentId remains readable for legacy task JSON. */
  agentHandle?: string;
  agentId?: string;
  model: "openai-codex/gpt-5.6-luna";
  thinkingLevel: "max";
  startedAt?: string;
  completedAt?: string;
  result?: string;
  failure?: string;
  diagnostics?: HerdrDiagnostic[];
}

export interface HerdrAgentState {
  name: string;
  paneId: string;
  agentStatus?: string;
  stateChangeSeq?: number;
  revision?: number;
  interactiveReady?: boolean;
}

export interface CorrectionProof {
  route: "herdr-worker" | "pi-lead";
  attemptId: string;
  round: number;
  matched: boolean;
}

export interface CorrectionAttempt {
  attemptId: string;
  round: number;
  route: "herdr-worker" | "pi-lead";
  status: "claimed" | "dispatched" | "completed" | "failed" | "ambiguous";
  workerId?: string;
  agentHandle?: string;
  paneId?: string;
  correctionRoundBaseline?: WorkspaceBaseline;
  herdrTurn?: HerdrTurnEvidence;
  correctionFilesChanged?: string[];
  scopeEvidence?: ScopeEvidence;
  proof?: CorrectionProof;
}

export interface HerdrTurnEvidence {
  agentHandle: string;
  paneId: string;
  before: HerdrAgentState;
  prompt: HerdrDiagnostic;
  after?: HerdrAgentState;
  turnObserved: boolean;
  diagnostics?: HerdrDiagnostic[];
}

export interface HerdrDiagnostic {
  operation: "pane split" | "agent start" | "agent get" | "agent prompt" | "agent wait";
  args: string[];
  exitCode?: number;
  stdout: string;
  stderr: string;
  paneId?: string;
  agentId?: string;
  agentHandle?: string;
  protocolError?: string;
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
  workers?: HerdrWorkerRecord[];
  baseline?: WorkspaceBaseline;
  scopeEvidence?: ScopeEvidence;
  herdrTurn?: HerdrTurnEvidence;
  correctionRoundBaseline?: WorkspaceBaseline;
  correctionAttemptId?: string;
  correctionAttempt?: CorrectionAttempt;
  proof?: CorrectionProof;
  error?: string;
  round?: number; // V2: 0 = initial execution, n = correction round n
}

export interface GitEvidence {
  capturedAt: string;
  source?: "pi" | "review";
  authoritative?: boolean;
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
  /** Snapshot of Pi extension method state at planning start. */
  activeMethods?: string[];
  requestedExecutionMode?: "single" | "herdr";
  status: TaskStatus;
  chat?: ChatSessionMetadata;
  plan?: PlannerPlan;
  planRevisions?: PlanRevisionState;
  execution?: ExecutionResult;
  correctionAttempt?: CorrectionAttempt;
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

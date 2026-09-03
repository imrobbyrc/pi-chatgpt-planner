# pi-chatgpt-planner

Pi-native bridge that uses **ChatGPT Web** as external planner, architect, and semantic reviewer while **Pi remains local execution authority**. It uses ChatGPT Web through browser/CDP, not OpenAI API, and stays standalone.

## What it does

Start in Pi:

```text
/chatgpt-plan "implement feature X"
```

Pi opens fresh ChatGPT Web planning target. ChatGPT inspects trusted workspace through bounded MCP tools, submits structured plan, and returns it to Pi. After explicit approval, Pi executes, validates, captures evidence, and sends same ChatGPT target actual workspace/diff for semantic review.

```text
PLAN → ADJUST → APPROVE → EXECUTE → VALIDATE → REVIEW → APPROVED
                                      │
                                      └→ CHANGES_REQUESTED → CORRECT → REVIEW
```

**V2.2 is implemented and live-tested.** This includes single-agent execution, explicit Herdr multi-agent execution, same-target semantic review, bounded corrections, baseline attribution, scope enforcement, and safe restart handling.

## Architecture

```text
                         ChatGPT Web
                    Planner / Reviewer
                         │       ▲
                  browser/CDP   │ same target
                  CONTROL PLANE  │ semantic review
                         │       │
                         ▼       │
                    Pi Lead / Pi
                    orchestrator
                    │          │
       single-agent Pi         Herdr Max (explicit)
                               ├─ Worker 1
                               ├─ Worker 2
                               ├─ Worker 3
                               └─ Worker 4
                                      │
                                      ▼
                              shared working tree
                                      │
                                      ▼
                            authoritative evidence
```

### Control plane

Pi controls a user-authorized Dia or Chrome browser over CDP. The browser controller opens/focuses ChatGPT Web, attaches the configured **Pi Workspace** app, and sends a small task/control prompt. It does **not** scrape ChatGPT responses.

### Data plane

ChatGPT reads the repository through Pi Workspace MCP:

```text
ChatGPT Web → Pi Workspace app → OpenAI Secure MCP Tunnel → local MCP → workspace
```

Workspace tools are bounded and read-only: metadata, directory listing, file reads, search, repository map, git status/diff, review context, execution summary, test evidence, skills, and methods. `submit_plan`, `submit_plan_revision`, and `submit_review` write planner protocol state only; they cannot edit source or execute commands.

### Authority

| Capability | ChatGPT Web | Pi Lead | Herdr workers |
| --- | --- | --- | --- |
| Plan / architecture | yes | coordinates | follows approved objective |
| Read/search workspace | via MCP | yes | local execution |
| Edit source / run tests | no | yes | bounded approved scopes |
| Git mutation, commit, push, deploy | no | no automatic mutation | prohibited |
| Semantic review | same original target | records result | no |

Pi Lead owns execution, test execution, worker scheduling, and final workspace mutation. Herdr workers are bounded Pi sub-executors, not autonomous planners.

## Quick Start

### Prerequisites

- macOS first; Linux partially supported; Windows launcher not supported
- Node.js 20+
- Pi and Git
- Dia Browser (default proven backend) or optional Chrome/Chromium
- ChatGPT Web account/workspace supporting custom MCP apps and protocol writes
- `tunnel-client` configured for OpenAI Secure MCP Tunnel
- Pi Workspace custom ChatGPT app

### Install

```bash
git clone https://github.com/imrobbyrc/pi-chatgpt-planner.git
cd pi-chatgpt-planner
npm install
npm run typecheck
npm test
pi install .
```

For quick local iteration instead:

```bash
pi -e ./extensions/chatgpt-planner/index.ts
```

### Start browser and verify setup

Use dedicated browser profile:

```bash
npm run browser
npm run doctor
```

Log into ChatGPT in that dedicated window once. Chrome is optional:

```bash
npm run chrome
# or
PLANNER_BROWSER=chrome npm run browser
```

Configure tunnel credential in Pi once:

```text
/chatgpt-planner-auth
/chatgpt-planner-start
```

`/chatgpt-planner-info` shows infrastructure state, local/public MCP URLs, CDP endpoint, profile, and app name.

### Run first task

From trusted project workspace inside Pi:

```text
/chatgpt-plan "implement feature X"
```

Review returned plan. Adjust if needed, then approve:

```text
/chatgpt-plan-adjust "change backend design to use Redis"
/chatgpt-plan-approve
/chatgpt-plan-status
```

Approval starts Pi execution. Do not approve until plan and scope are correct.

## How to Use

### Single-agent planning: `/chatgpt-plan`

```text
/chatgpt-plan "implement feature X"
```

Creates fresh planning task. ChatGPT inspects workspace and submits plan. It remains **single-agent**: approval sends approved contract to Pi Lead and never escalates to Herdr automatically.

### Adjust plan

Before approval, use:

```text
/chatgpt-plan-adjust "split backend and frontend into independent workers"
```

Adjustments reuse same ChatGPT target and append immutable revision history. Each revision has a base revision; stale or ambiguous revisions fail. Approval freezes selected revision and its worker contract/context. New scope after approval requires new planning task; approved contract is not silently changed.

Optional task id or unique prefix may precede feedback:

```text
/chatgpt-plan-adjust 2e87b64a "use Redis instead"
```

### Approve or reject

```text
/chatgpt-plan-approve [task-id]
/chatgpt-plan-reject [task-id]
```

Task id is optional when current session task is unambiguous. Approval is explicit and required. Full UUIDs and unique prefixes work; ambiguous prefixes fail closed.

### Status and task list

```text
/chatgpt-plan-status [task-id]
/chatgpt-plan-list
```

Current task is session-only. After Pi restart, provide an unambiguous id rather than relying on newest task selection.

### Multi-agent / Max

```text
/chatgpt-plan-max "implement feature X"
```

This is the only multi-agent entry point. ChatGPT may produce 1–4 workers. Approval freezes each worker's `id`, objective, ownership, and dependencies. Pi Lead schedules approved workers in Herdr.

### Review and correction

After successful execution, Pi captures authoritative evidence and automatically asks **same original ChatGPT target** to review. ChatGPT can inspect changed files, git status/diff, execution summary, baseline-relative changes, ownership evidence, and review history through MCP. It submits either:

- `APPROVED`: task reaches approved terminal review state.
- `CHANGES_REQUESTED`: Pi performs bounded correction, then asks same target to review again.

Testing success is not final authority; semantic review checks whether implementation satisfies approved intent. `/chatgpt-plan-review [task-id]` retries operationally failed review without rerunning execution. `/chatgpt-plan-recover [task-id]` handles legacy operational recovery.

Only accepted `submit_review` calls consume semantic review iterations. Timeouts, transport failures, and other operational failures do not. Review iterations are bounded by `PLANNER_MAX_REVIEW_ITERATIONS` (default `3`). Scope-expansion findings stop correction instead of changing approved scope.

## `/chatgpt-plan` vs `/chatgpt-plan-max`

| | `/chatgpt-plan` | `/chatgpt-plan-max` |
| --- | --- | --- |
| Execution | Pi Lead / single agent | Herdr workers |
| Multi-agent | No | Explicit opt-in |
| Workers | N/A | 1–4 |
| Worker profile | Pi executor | `openai-codex/gpt-5.6-luna`, thinking `max` |
| Parallelism | N/A | Only independent, non-overlapping scopes |
| Approval | Required | Required |
| Semantic review | Same ChatGPT target | Same ChatGPT target |
| Correction | Pi Lead | Same worker when unique owner/context is safely reusable; otherwise Pi Lead |

## Multi-agent execution

ChatGPT defines worker DAG:

```text
worker-backend:  owns backend/**, dependsOn []
worker-frontend: owns frontend/**, dependsOn [worker-backend]
```

Workers use one shared working tree. Pi starts workers only when dependencies are complete and ownership scopes are provably non-overlapping. Failed workers stop dependent work. Workers cannot spawn panes, delegate, switch models, commit, push, deploy, or expand scope. No worktree-per-worker and no automatic escalation from normal planning.

## Review & correction details

### Same-worker reuse (V2.2)

When every finding maps uniquely to one completed worker's owned scope, Pi reuses that exact Herdr context:

```text
finding → unique owner → same agentHandle + same paneId → correction turn
```

No replacement worker is created. Correction turn includes original context, approved ownership, and reviewer instructions. Original objective is historical context; current correction instructions supersede conflicting content/state requirements. Ownership, dependencies, scope, and safety constraints remain binding.

### Correction proof and fail-closed recovery

Each correction persists a `CorrectionAttempt` through:

```text
claimed → dispatched → completed
                       └→ failed / ambiguous
```

Proof includes worker identity, pane identity, correction-round baseline, turn evidence, changed files, and scope evidence. A generic executor `status=completed` is insufficient. Pi continues review only after valid completion proof is persisted.

If Pi restarts after dispatch may have happened, correction is ambiguous. Pi does not replay prompt, create replacement worker, or apply automatic Pi Lead overlay. It fails closed and needs attention; possible mutation may already exist.

### Baselines and attribution

Workspace need not be clean. Pi captures original task baseline:

```text
original baseline A → initial execution B
correction baseline B → correction C
final task delta A → C
```

Pre-existing dirty files are not task-attributable unless task execution changes them further. Correction baseline measures only correction delta and never replaces original baseline.

### Ownership evidence

Pi records `filesChanged`, `ownersByFile`, `unownedFiles`, and `ambiguousOwnerFiles`. A source mutation outside approved ownership, or ambiguous ownership, fails closed. Example: worker owning `backend/**` changing `frontend/foo.ts` is not silently accepted.

## Skills and methods

Pi skills provide reusable domain/procedure knowledge. Methods provide workflow context such as Design Thinking. Pi/user state controls active methods; ChatGPT cannot activate or change them. Planner receives only task-scoped active method context. Plan revisions preserve selected context for execution and review.

## Commands

| Command | Purpose |
| --- | --- |
| `/chatgpt-plan <task>` | Single-agent ChatGPT planning round-trip |
| `/chatgpt-plan-max <task>` | Explicit 1–4 worker Herdr planning round-trip |
| `/chatgpt-plan-adjust [task-id] <feedback>` | Revise plan before approval |
| `/chatgpt-plan-approve [task-id]` | Freeze approved revision and execute |
| `/chatgpt-plan-reject [task-id]` | Reject plan |
| `/chatgpt-plan-status [task-id]` | Show task, plan, execution, review |
| `/chatgpt-plan-list` | List/select recent tasks |
| `/chatgpt-plan-review [task-id]` | Retry review for executed task |
| `/chatgpt-plan-recover [task-id]` | Recover operational review attempt |
| `/chatgpt-planner-auth` | Store Secure MCP Tunnel credential |
| `/chatgpt-planner-auth-clear` | Remove stored credential |
| `/chatgpt-planner-start` | Start planner infrastructure |
| `/chatgpt-planner-stop` | Stop planner infrastructure |
| `/chatgpt-planner-info` | Show configuration and health |
| `/chatgpt-browser-debug` | Save visible ChatGPT control diagnostics |

## Setup and configuration

### Local MCP and tunnel

Planner starts local MCP lazily at:

```text
http://127.0.0.1:8765/mcp
```

Health endpoint:

```text
http://127.0.0.1:8765/healthz
```

ChatGPT cannot reach localhost directly. Use configured `tunnel-client` and OpenAI Secure MCP Tunnel:

```text
127.0.0.1:8765/mcp → tunnel-client → Secure MCP Tunnel → Pi Workspace app
```

Create custom ChatGPT app named `Pi Workspace`, point it at tunnel's remote endpoint, scan tools, and confirm `submit_plan`, `submit_plan_revision`, and `submit_review` are available. Keep local server loopback-bound. See [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md).

### Configuration precedence

Defaults < `~/.pi/chatgpt-planner/config.json` < environment variables. Copy [`config.example.json`](config.example.json) to that path.

| Variable | Default |
| --- | --- |
| `PLANNER_MCP_HOST` | `127.0.0.1` |
| `PLANNER_MCP_PORT` | `8765` |
| `PLANNER_MCP_PATH` | `/mcp` |
| `PLANNER_PUBLIC_MCP_URL` | unset |
| `PLANNER_BROWSER` | `dia` |
| `PLANNER_BROWSER_BINARY` | unset |
| `PLANNER_BROWSER_PROFILE_DIR` | `~/.pi/chatgpt-planner/<browser>-profile` |
| `PLANNER_CDP_HOST` / `PLANNER_CDP_PORT` | `127.0.0.1` / `9222` |
| `PLANNER_CHATGPT_URL` | `https://chatgpt.com/` |
| `PLANNER_CHATGPT_APP_NAME` | `Pi Workspace` |
| `PLANNER_BROWSER_AUTO_ATTACH_APP` | `true` |
| `PLANNER_TIMEOUT_MS` | `600000` |
| `PLANNER_MAX_READ_LINES` | `500` |
| `PLANNER_MAX_FILE_BYTES` | `1000000` |
| `PLANNER_MAX_REVIEW_ITERATIONS` | `3` |
| `PLANNER_REVIEW_TIMEOUT_MS` | `600000` |
| `PLANNER_BROWSER_STARTUP_TIMEOUT_MS` | `20000` |

### Browser attachment troubleshooting

If app attachment cannot be confirmed, select `Pi Workspace` manually in ChatGPT. `/chatgpt-browser-debug` captures visible composer/app-picker diagnostics; it never reads response content. ChatGPT UI controls may change.

For infrastructure failures, run `/chatgpt-planner-start`, then retry `/chatgpt-plan-review <task-id>` without rerunning execution. Keep original Pi-owned planner browser and Temporary Chat open through review. If that target closes, same-target review cannot resume; create new planning task.

Run `npm run doctor` to check Node, Git, Pi, and CDP reachability.

## State, security, and recovery

Task state persists outside repository by default:

```text
~/.pi/chatgpt-planner/
├── config.json
├── .env
├── dia-profile/
└── tasks/<uuid>.json
```

Read [`SECURITY.md`](SECURITY.md) before exposing MCP. Key boundaries:

- local MCP binds to `127.0.0.1` by default;
- every workspace request requires task id mapped to trusted workspace root;
- real-path checks prevent escaping workspace;
- file reads are bounded and generated/vendor paths skipped;
- ChatGPT receives no shell, write, package, migration, git-mutation, commit, push, or deploy tools;
- credentials remain browser-owned; Node process does not read browser cookies/passwords;
- planner never auto-commits, pushes, or deploys;
- shutdown warns about unfinished reviews and does not fabricate replacement target;
- ambiguous correction after restart is never replayed.

## Limitations

- ChatGPT UI settings and app-picker markup can change; manual selection may be required.
- Temporary Chat `targetId` is authoritative only while original Pi-owned browser target remains alive; conversation URL/id are optional metadata.
- Some ChatGPT workspaces may disallow MCP protocol writes.
- MCP server has no OAuth/pairing; never expose loopback endpoint directly to public internet.
- Pi extension events do not provide authoritative per-command test output; empty validation evidence is left empty rather than fabricated.
- Scope expansion requires a new planning task; review loop is finite.

## Roadmap

Current V2.2 is complete. Remaining work and future V3 ideas are tracked in [`ROADMAP.md`](ROADMAP.md). Historical V0/V1 milestones remain there for project context; they are not current usage requirements.

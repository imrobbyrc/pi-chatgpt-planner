# AGENTS.md — continuation contract for Codex and coding agents

Read this file before modifying the repository.

## Mission

Build a **Pi-native planner bridge** where the user starts in Pi:

```text
/chatgpt-plan <task>
```

A real logged-in **ChatGPT Web** session acts as external planner/architect. ChatGPT inspects the local repository through a bounded MCP server and returns its plan to Pi. Pi remains the coding harness/executor.

The project must remain standalone. Do **not** import, vendor, fork, or add a runtime dependency on `XiaoDuoYa/codex-with-chatgpt`.

## User intent that must not drift

The desired direction is:

```text
Pi -> ChatGPT Web -> Pi
```

not:

```text
ChatGPT Web -> start Pi
```

and not:

```text
Pi -> OpenAI API
```

The user specifically wants ChatGPT Web to do planning while Pi stays the harness.

## Core architecture

Maintain two channels:

1. **Control plane:** Pi controls a user-authorized ChatGPT Web browser session via configurable Browser/CDP and sends a tiny task/control message.
2. **Data plane:** ChatGPT pulls repository context through MCP and returns structured planner state through `submit_plan`.

Do not paste large source files/diffs through the browser control plane.

## Trust boundary — non-negotiable

ChatGPT MCP MAY:

- inspect workspace metadata,
- list/read bounded source files,
- search source,
- read git status/diff,
- submit planner/review protocol state.

ChatGPT MCP MUST NOT receive:

- arbitrary shell execution,
- source write/edit tools,
- package install commands,
- migrations,
- git commit/push/reset/checkout mutation,
- deployment tools.

Pi is the only executor.

`submit_plan` is a real protocol write. Keep its tool annotation honest (`readOnlyHint: false`). Never pretend it is read-only to bypass ChatGPT plan/workspace restrictions.

## Browser rule

Browser control is allowed to open/focus ChatGPT and send the planning instruction. **Do not make browser DOM scraping of ChatGPT's response the primary return path.** The supported return channel is MCP `submit_plan`.

Do not read/export cookies or credentials. Continue using a dedicated browser `--user-data-dir` profile controlled by the user.

## Current implementation state

V0 is proven end-to-end with real Dia Browser / ChatGPT Web:

```text
Pi /chatgpt-plan -> Dia CDP 127.0.0.1:9222 -> ChatGPT Web
  -> OpenAI Secure MCP Tunnel via tunnel-client
  -> Pi Workspace custom ChatGPT plugin
  -> local MCP 127.0.0.1:8765/mcp -> submit_plan -> Pi preview
```

No project source files were modified during proof. V0 contains:

- Pi package manifest in `package.json`.
- Pi extension at `extensions/chatgpt-planner/index.ts`.
- `/chatgpt-plan`, `/chatgpt-plan-status`, `/chatgpt-planner-info` commands.
- persistent task state under `~/.pi/chatgpt-planner/tasks`.
- lazy local MCP HTTP server.
- task-scoped workspace tools with path-boundary checks.
- structured `submit_plan`.
- Browser/CDP controller that sends the planner request and experimentally attaches the configured ChatGPT app.
- doctor and configurable browser launcher scripts.
- initial unit tests.

Dependencies are installed and V0 has passed typecheck/tests plus one real round-trip. Chrome remains optional backend; proven browser is Dia at CDP `127.0.0.1:9222`.

## Next work — V0.1 isolated planning sessions, then V1

V0 proof is complete. V0.1 must capture active conversation, invoke ChatGPT New Chat, confirm fresh state, attempt Personalized Temporary Chat and High reasoning, attach Pi Workspace, persist conversation identity, and warn on unconfirmed UI state. Preserve no-response-scraping architecture and MCP trust boundary.

### V1 implementation plan

1. Add explicit user confirmation before execution.
2. Inject approved plan into Pi as external architect contract.
3. Execute through Pi only; record deviations and test commands/results.
4. Never automatically commit, push, or deploy.

V2 remains independent ChatGPT review of actual diff and test state.
## V1 constraints

V1 adds an explicit user confirmation gate and lets Pi execute an accepted external plan. Keep planning and execution roles separate. The external plan should be injected into Pi as an architect contract, with deviations recorded when implementation discovers a real conflict.

Do not automatically commit, push, or deploy.

## V2 constraints

V2 adds independent review. ChatGPT must inspect the actual diff and test state itself through MCP; never rely only on Pi saying tests passed.

Likely protocol additions:

- `test_status` (read-only)
- `execution_summary` (read-only)
- `submit_review` (protocol write only)

Use a bounded review/fix loop.

## Code quality expectations

- TypeScript strict mode stays on.
- Path safety must be covered by tests.
- Avoid shell string interpolation; prefer `execFile`/argument arrays.
- Keep source reads bounded.
- Do not log file bodies by default.
- Prefer small modules with clear ownership.
- Keep platform-specific browser launch logic isolated.
- All long-lived resources must start lazily and stop on Pi `session_shutdown`.
- Update README/ROADMAP when behavior changes.

## Current highest-risk areas

1. Exact current MCP v2 package versions/API names.
2. Fastify <-> MCP Node adapter correctness.
3. Pi extension import resolution when installed as a git/local Pi package.
4. Browser/ChatGPT app-selection DOM/mention behavior.
5. Remote MCP authentication/tunnel setup.
6. ChatGPT workspace plan support for `submit_plan` write actions.

Treat failures here as expected engineering work, not reasons to redesign the project into an API-based planner.

## Definition of V0 done — met

One real end-to-end task completed:

```text
Pi command
 -> ChatGPT Web planner
 -> MCP repository inspection
 -> submit_plan
 -> plan previewed in Pi
```

with zero workspace writes.

# pi-chatgpt-planner

Pi-native experiment that uses **ChatGPT Web as the planning/review brain** while keeping **Pi as the local coding harness and executor**.

This repository is intentionally standalone. It does **not** depend on `codex-with-chatgpt`, does not call the OpenAI API for planning, and does not replace Pi's model provider.

> **Current status: V0 proven end-to-end.** A real Dia/ChatGPT Web session has completed `/chatgpt-plan` through the OpenAI Secure MCP Tunnel: ChatGPT inspected the local workspace and returned a structured plan through `submit_plan`. No project source files were modified. V0 does not execute plans.

## The target UX

```text
$ cd my-project
$ pi

> /chatgpt-plan Add multi-item stock transfer with per-item approval

Preparing ChatGPT planner…
Opening the authorized ChatGPT Web session…
Waiting for external plan…

✓ ChatGPT plan received

# Stock transfer multi-item plan
1. ...
2. ...

(V0 stops here.)
```

Later versions will add:

```text
PLAN (ChatGPT Web)
  -> EXECUTE (Pi)
  -> TEST (Pi)
  -> REVIEW (ChatGPT Web reads actual git diff)
  -> FIX (Pi)
  -> REVIEW
  -> APPROVED
```

## Architecture

There are two deliberately separate channels:

```text
                         ChatGPT Web
                    Plan / reason / review
                       /             \
                      /               \
             Browser / CDP             MCP
              CONTROL PLANE         DATA PLANE
                    |                   |
                    v                   v
          pi-chatgpt-planner       Workspace tools
             Pi extension          read_file/search
                    \                 git status/diff
                     \                 /
                      \               /
                       local workspace
                              |
                              v
                             Pi
                         future executor
```

### Control plane

The control plane starts from Pi. `/chatgpt-plan ...` uses a user-authorized Browser/CDP session to open/focus ChatGPT Web and send a small planning instruction containing a task id.

**It does not read or scrape ChatGPT's final answer.** The browser controller only sends the request. The plan comes back through MCP.

### Data plane

ChatGPT uses the custom **Pi Workspace** MCP app to inspect the actual repository through bounded, read-only tools:

- `workspace_info`
- `repo_map`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff` (primarily for the later review loop)

The only protocol-side write in V0 is:

- `submit_plan`

`submit_plan` writes planner task JSON under `~/.pi/chatgpt-planner/tasks/`. It **cannot edit source files, run shell commands, create commits, or mutate git**.

## Why this shape

The important trust boundary is intentional:

| Capability | ChatGPT Web | Pi |
| --- | ---: | ---: |
| Read source | yes, through MCP | yes |
| Search source | yes, through MCP | yes |
| Inspect git diff | yes, through MCP | yes |
| Architecture / plan | yes | execution should follow it |
| Edit source | **no** | yes |
| Run shell/tests | **no** | yes |
| Git mutation | **no** | yes |
| Submit planner state | yes | reads it |

This keeps the external planner independent from the code-writing harness.

## Prerequisites

V0 assumes:

- macOS first (Linux is partially supported; Windows launcher is TODO),
- Node.js 20+,
- Pi installed,
- Git,
- Dia Browser (working backend; Chrome/Chromium remains optional),
- a ChatGPT Web account with custom MCP/app support for `submit_plan`,
- OpenAI Secure MCP Tunnel with `tunnel-client`,
- the Pi Workspace custom ChatGPT plugin/app.

Pi's current package model supports TypeScript extensions and package manifests, so this repo can be installed locally with `pi install ./path/to/pi-chatgpt-planner` once dependencies are installed.

## Important ChatGPT MCP capability check

The automatic round-trip requires ChatGPT to be allowed to call `submit_plan`, which is correctly declared as a **non-destructive write action** because it changes planner protocol state.

Do **not** disguise `submit_plan` as a read-only tool just to bypass plan restrictions. If the connected ChatGPT account/workspace only permits read/fetch MCP tools, V0 can still prove workspace reads but cannot complete the automatic handoff until a supported write path is available.

## 1. Install locally

```bash
git clone https://github.com/imrobbyrc/pi-chatgpt-planner.git
cd pi-chatgpt-planner
npm install
npm run typecheck
npm test
```

During development, install this checkout into Pi:

```bash
pi install .
```

Alternatively run Pi with an explicit extension path for quick iteration:

```bash
pi -e ./extensions/chatgpt-planner/index.ts
```

## 2. Start a dedicated browser profile with CDP

V0 uses Dia by default on macOS with an isolated planner profile instead of attaching to your daily browser profile.

```bash
npm run browser
```

Launcher passes loopback CDP and profile arguments:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
--user-data-dir=$HOME/.pi/chatgpt-planner/dia-profile
```

Launcher polls `http://127.0.0.1:9222/json/version` and reports success only after CDP responds. Log into ChatGPT once in that dedicated window; profile is reused.

Chrome remains available:

```bash
npm run chrome
# or: PLANNER_BROWSER=chrome npm run browser
```

Set `PLANNER_BROWSER_BINARY` for a custom executable path.

The project never reads or stores your ChatGPT password. It relies on the browser profile you authorized yourself.

Verify prerequisites:

```bash
npm run doctor
```

## 3. Connect local MCP to ChatGPT

The extension starts its MCP HTTP server lazily when `/chatgpt-plan` is first used:

```text
http://127.0.0.1:8765/mcp
```

Working V0 setup:

```text
Pi local MCP 127.0.0.1:8765/mcp
    -> tunnel-client
    -> OpenAI Secure MCP Tunnel
    -> Pi Workspace custom ChatGPT plugin
```

Run `tunnel-client` according to your OpenAI Secure MCP Tunnel configuration and point the Pi Workspace plugin at its assigned remote endpoint. Scan tools and confirm `submit_plan` is available. ChatGPT must not connect directly to localhost.

See [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md) for setup notes.

Set the public URL for diagnostics/documentation:

```bash
export PLANNER_PUBLIC_MCP_URL=https://pi-planner.example.com/mcp
```

## 4. Create the ChatGPT custom app

In ChatGPT Web developer/app settings, create a custom MCP app pointed at the remote MCP URL. Suggested name:

```text
Pi Workspace
```

That exact name is the default expected by the browser controller. It can be changed:

```bash
export PLANNER_CHATGPT_APP_NAME="My Pi Workspace"
```

Scan tools and verify that ChatGPT sees the workspace tools plus `submit_plan`.

Do not publish the app broadly. This server exposes source-code reads from whichever trusted Pi workspace owns a valid task id.

## 5. Run V0

From a project you are willing to expose read-only to ChatGPT:

```bash
cd ~/Projects/example
pi
```

Then:

```text
/chatgpt-plan Add validation to the stock transfer approval flow
```

The command does the following:

1. checks that the current Pi project is trusted,
2. starts the local MCP server if it is not already running,
3. creates a task JSON with a random UUID and the current workspace root,
4. connects to configured browser over CDP,
5. tries to attach/mention the configured ChatGPT app (or recognizes an existing composer attachment),
6. sends the planner instruction containing the task id,
7. waits locally for `submit_plan(task_id=...)`,
8. opens the returned plan in a Pi editor preview.

No Pi implementation model is invoked by `/chatgpt-plan` in V0.

## Useful Pi commands

```text
/chatgpt-plan <task>
```

Start a new external planning round-trip.

```text
/chatgpt-plan-status [task-id]
```

Show a task. With no id, shows the newest task.

```text
/chatgpt-planner-info
```

Show local MCP URL, public URL configuration, state directory, CDP endpoint, and app name.

```text
/chatgpt-browser-debug
```

Create a fresh planner tab without sending a message and save visible ChatGPT control metadata under `~/.pi/chatgpt-planner/debug/`.

## Configuration

Configuration is loaded from:

1. defaults,
2. `~/.pi/chatgpt-planner/config.json`,
3. environment variables (highest precedence).

Copy [`config.example.json`](config.example.json) to:

```text
~/.pi/chatgpt-planner/config.json
```

Useful environment variables:

| Variable | Default |
| --- | --- |
| `PLANNER_MCP_HOST` | `127.0.0.1` |
| `PLANNER_MCP_PORT` | `8765` |
| `PLANNER_MCP_PATH` | `/mcp` |
| `PLANNER_PUBLIC_MCP_URL` | unset |
| `PLANNER_BROWSER` | `dia` (`chrome` optional) |
| `PLANNER_BROWSER_BINARY` | unset |
| `PLANNER_BROWSER_PROFILE_DIR` | `~/.pi/chatgpt-planner/<browser>-profile` |
| `PLANNER_BROWSER_STARTUP_TIMEOUT_MS` | `20000` |
| `PLANNER_CDP_HOST` | `127.0.0.1` |
| `PLANNER_CDP_PORT` | `9222` |
| `PLANNER_CHATGPT_URL` | `https://chatgpt.com/` |
| `PLANNER_CHATGPT_APP_NAME` | `Pi Workspace` |
| `PLANNER_BROWSER_AUTO_ATTACH_APP` | `true` |
| `PLANNER_TIMEOUT_MS` | `600000` |
| `PLANNER_MAX_READ_LINES` | `500` |
| `PLANNER_MAX_FILE_BYTES` | `1000000` |

## V0.1 isolated ChatGPT sessions

Each `/chatgpt-plan` creates a new CDP target at `https://chatgpt.com/`; it never attaches to or navigates the user's active ChatGPT tab. The new target id is persisted before setup. Controller confirms fresh state, Temporary Chat, Personalized mode, and High reasoning before attaching Pi Workspace and sending the existing task-id prompt. Any required confirmation failure aborts before sending. Resulting target id and conversation URL/id are persisted when exposed.

Settings are confirmed through visible controls/selection state. Plan return remains `submit_plan`, never assistant DOM scraping.

## Browser app attachment

V0 proof used Dia Browser over CDP at `127.0.0.1:9222`. Chrome remains an optional backend.

ChatGPT Web UI can change. The current controller:

- finds visible `contenteditable` composer,
- recognizes existing app-chip/mention signals near composer,
- otherwise types `@<app name>` and clicks matching visible menu option,
- rechecks composer attachment signals,
- inserts planner prompt and presses Enter.

If attachment cannot be confirmed from composer/app-picker state, Pi warns you and continues waiting. Select Pi Workspace manually if needed. Detection only inspects composer and app-picker UI state; it never scrapes ChatGPT responses. The supported return path remains MCP `submit_plan`.

Attachment detection has regression coverage; UI markup remains a known compatibility boundary.

## State format

Tasks live outside the project repository by default:

```text
~/.pi/chatgpt-planner/
├── config.json
├── dia-profile/
└── tasks/
    └── <uuid>.json
```

Example task after completion:

```json
{
  "id": "...",
  "workspaceRoot": "/Users/me/Projects/stockflow",
  "request": "Add multi-item stock transfer",
  "status": "plan_received",
  "plan": {
    "summary": "...",
    "planMarkdown": "...",
    "filesToInspect": [],
    "acceptanceCriteria": [],
    "tests": [],
    "risks": [],
    "openQuestions": [],
    "submittedAt": "..."
  }
}
```

## Security model

Read [`SECURITY.md`](SECURITY.md) before exposing the MCP endpoint.

The most important properties are:

- server binds to `127.0.0.1` by default,
- every workspace tool requires a UUID task id,
- task ids map to explicit workspace roots,
- file paths are resolved through real paths and must remain below that root,
- source-code MCP tools are read-only,
- large/binary file reads are rejected,
- common generated/vendor directories are skipped,
- `submit_plan` only updates task state,
- no browser cookies/passwords are read by the Node process,
- configured browser uses a dedicated user-data directory.

V0 does **not** yet implement OAuth/pairing on the MCP server. Therefore do not expose the local endpoint directly to the public internet. Put a secure tunnel/access layer in front of it and keep the server running only while using Pi.

## Known limitations

1. **ChatGPT settings UI:** Temporary/personalized/reasoning controls and app picker markup may change; warnings/manual selection remain fallback.
2. **Conversation URL:** ChatGPT may delay or hide conversation id; task stores URL when exposed.
3. **MCP write availability:** some ChatGPT plans/workspaces may not permit `submit_plan`.
4. **No OAuth/pairing yet:** V0 delegates remote authentication to OpenAI Secure MCP Tunnel.
5. **No execution or review loop:** V0.1 intentionally stops after displaying the plan.

## Development roadmap

See [`ROADMAP.md`](ROADMAP.md). In short:

- **V0:** proven: `/chatgpt-plan -> Dia/CDP -> ChatGPT Web -> OpenAI Secure MCP Tunnel -> Pi Workspace MCP -> submit_plan -> Pi`.
- **V0.1:** proven-session hardening: new personalized Temporary Chat, High reasoning, app attachment, identity capture, defensive warnings.
- **V1:** confirmation gate then inject approved external plan into Pi for execution.
- **V2:** ChatGPT review of real `git_diff` + `test_status`; Pi fix loop.
- **V3:** optional `/feature --auto` orchestration with explicit safety limits.

## For Codex CLI / future agents

Read [`AGENTS.md`](AGENTS.md) before changing anything. It contains the architectural constraints, current implementation state, ordered next tasks, and acceptance criteria for continuing this project without drifting into a different design.

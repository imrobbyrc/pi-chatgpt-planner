# MCP setup notes

## Local endpoint

When Pi starts the planner runtime, the default MCP endpoint is:

```text
http://127.0.0.1:8765/mcp
```

Health check:

```text
http://127.0.0.1:8765/healthz
```

You can also run the server separately while developing:

```bash
npm run dev:mcp
```

## Remote connectivity

ChatGPT Web requires remotely reachable MCP endpoint; localhost is not directly reachable.

**Proven V0 path:**

```text
http://127.0.0.1:8765/mcp
  -> tunnel-client
  -> OpenAI Secure MCP Tunnel
  -> Pi Workspace custom ChatGPT plugin
```

Run `tunnel-client` using your OpenAI Secure MCP Tunnel account/configuration. Configure Pi Workspace with remote endpoint it provides. Keep local server bound to loopback. Stable endpoint matters because ChatGPT plugin stores endpoint configuration.

Cloudflare named tunnel or another private authenticated tunnel remains optional fallback.

## Cloudflare named tunnel shape (example, not automated yet)

The desired mapping is simply:

```text
https://pi-planner.example.com/mcp
              |
              v
http://127.0.0.1:8765/mcp
```

Keep cloudflared/tunnel configuration outside this repo for V0. Do not commit credentials.

## ChatGPT app

Create/configure custom MCP app/plugin named `Pi Workspace` (or change `PLANNER_CHATGPT_APP_NAME`). Point it at remote endpoint from `tunnel-client` and scan tools. This exact Pi Workspace setup was used in successful V0 round-trip.

Expected tools:

```text
workspace_info
repo_map
list_directory
read_file
search_workspace
git_status
git_diff
review_context
execution_summary
test_status
list_agent_skills
get_agent_skill
list_active_methods
get_method_context
submit_plan
submit_plan_revision
submit_review
```

`submit_plan`, `submit_plan_revision`, and `submit_review` are protocol-state writes, not workspace writes. All skill/method tools are bounded read-only discovery/content reads; ChatGPT cannot activate methods or execute skills. If the ChatGPT workspace only allows read/fetch MCP, planning/revision/review handoff cannot finish.

## Tool safety

The external host should never be given arbitrary workspace roots. Every call takes `task_id`; the server maps that id to a root created locally by Pi.

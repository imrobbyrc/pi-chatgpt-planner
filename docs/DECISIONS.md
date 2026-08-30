# Architecture decisions

## ADR-001 — Pi remains the harness

ChatGPT Web is not registered as a Pi model provider. Pi remains responsible for local coding execution and later tests/git operations.

## ADR-002 — ChatGPT Web is reached through a browser control plane

The user explicitly wants `/chatgpt-plan` to originate in Pi and use the existing ChatGPT Web session rather than the OpenAI API.

The browser control plane only sends the task instruction. It is not the plan return channel.

## ADR-003 — MCP is the workspace data plane

ChatGPT reads what it needs itself instead of Pi dumping source code into the browser prompt.

## ADR-004 — no source mutation through MCP

The external planner gets no shell/write/git mutation tools. `submit_plan` only updates protocol state outside the workspace.

## ADR-005 — no dependency on codex-with-chatgpt

That repository inspired the separation of control plane and data plane, but this codebase must remain standalone and Pi-native.

## ADR-006 — V0 stops after planning

Do not add autonomous execution before the planning transport works end-to-end. A small proof is more valuable than a large untested loop.

## ADR-007 — dedicated Browser/CDP profile

Avoid attaching automation to the user's normal browser profile. Dia is default on macOS; Chrome remains optional. The user logs in to ChatGPT manually in a dedicated profile; credentials remain browser-owned.

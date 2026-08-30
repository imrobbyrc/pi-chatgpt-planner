# Security

`pi-chatgpt-planner` intentionally exposes a trusted local code workspace to an external ChatGPT session through MCP. Treat that boundary as sensitive.

## Non-negotiable V0 rules

1. ChatGPT MCP tools may read source and git metadata only.
2. ChatGPT must not receive `bash`, arbitrary process execution, write-file, git mutation, package install, migration, or deployment tools.
3. `submit_plan` is allowed to update planner protocol state only. It must not write into the workspace.
4. Never mark a mutating tool as read-only to bypass host restrictions.
5. Never collect, export, or persist ChatGPT cookies/passwords. Configured browser owns the authenticated profile.
6. Keep the MCP server bound to loopback by default.
7. Use a secure remote tunnel/access layer; V0's server has no built-in OAuth/pairing.
8. Require a task id for every workspace operation so arbitrary roots cannot be selected by the model.
9. Resolve real paths and reject traversal/symlink escape outside the task workspace.
10. Do not add output scraping as the primary ChatGPT-to-Pi channel. The supported handoff is `submit_plan`.

## Threats intentionally mitigated

- path traversal outside the selected repository,
- accidental mutation by the external planner,
- blindly trusting Pi's later claims during review,
- accidental binary/huge file exfiltration,
- exposing a user's daily browser profile to automation.

## Threats not solved in V0

- MCP endpoint authentication and authorization,
- per-tool user confirmation beyond what the ChatGPT host provides,
- malicious content/prompt injection inside the source repository,
- a compromised tunnel/access provider,
- multiple simultaneous users/workspaces,
- browser UI changes.

## Before V1/V2

Add an authenticated remote MCP story (prefer a supported Secure MCP Tunnel or a proper OAuth/pairing layer), structured audit logs, and explicit review/fix iteration limits.

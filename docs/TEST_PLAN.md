# V0 test plan

## Unit

- TaskStore create/submit state transition.
- Workspace path traversal rejection.
- Add symlink escape coverage.
- Add read limit and binary rejection coverage.
- Add search max-result coverage.

## Local integration

1. `npm install`
2. `npm run typecheck`
3. `npm test`
4. `npm run browser`
5. log in to ChatGPT in dedicated Browser/CDP profile
6. `npm run doctor`
7. `npm run dev:mcp`
8. call `/healthz`
9. use an MCP inspector/client to list tools and call `workspace_info` against a fixture task

## Pi integration

1. `pi install .`
2. start Pi in a trusted test repo
3. `/chatgpt-planner-info`
4. `/chatgpt-plan explain how to add a harmless README section`
5. verify browser opens/focuses ChatGPT
6. verify the Pi Workspace app is attached or manually attach it
7. verify ChatGPT calls workspace tools
8. verify ChatGPT calls `submit_plan`
9. verify Pi previews the plan and does not modify the test repo

## Failure cases

- configured Browser/CDP not running -> actionable error.
- ChatGPT profile logged out -> composer/login error, no source mutation.
- MCP tunnel down -> Pi times out, task is inspectable.
- invalid task id -> MCP tool error.
- path traversal -> rejected.
- oversized/binary file -> rejected.
- ChatGPT app cannot call write action -> document capability issue; do not mislabel `submit_plan`.

# Roadmap

## V0 — planning round-trip (proven)

Goal:

```text
Pi /chatgpt-plan
  -> browser control sends task id to ChatGPT Web
  -> ChatGPT reads workspace via MCP
  -> ChatGPT calls submit_plan
  -> Pi displays plan
```

Acceptance criteria:

- [x] Pi extension registers `/chatgpt-plan`.
- [x] Task store persists outside project source tree.
- [x] Local MCP server starts lazily.
- [x] Workspace reads are root-bounded and read-only.
- [x] MCP exposes `submit_plan` as a non-destructive write action.
- [x] Browser control uses user-authorized configurable Browser/CDP session.
- [x] Browser control does not read/scrape plan output.
- [x] Pi polls local task state and previews the received plan.
- [x] Run `npm install`, typecheck, and tests on development machine.
- [x] Connect Pi Workspace custom ChatGPT plugin and verify tool scan.
- [x] Complete one end-to-end real planning task through Dia/CDP, OpenAI Secure MCP Tunnel, and `tunnel-client`.
- [x] Verify workspace MCP reads and `submit_plan` return to Pi.
- [x] Confirm no project source files were modified.

## V0.1 — isolated planning sessions (in progress)

- [x] Record proven Dia/CDP + OpenAI Secure MCP Tunnel setup.
- [x] Create isolated CDP target at ChatGPT home without touching active conversation.
- [x] Confirm fresh state, Temporary Chat, and personalized variant before setup continues.
- [x] Confirm High reasoning from resulting selector state before sending.
- [x] Persist planner target id and conversation URL/id when exposed.
- [x] Abort before prompt when required state cannot be confirmed.
- [x] Improve app attachment detection without response scraping.
- [ ] Real-device verification of current ChatGPT UI controls.
- [ ] Add a manual fallback that pauses before send rather than failing silently.
- [x] Document OpenAI Secure MCP Tunnel + `tunnel-client` setup.
- [ ] Add stable remote MCP setup helper if tunnel CLI contract permits.
- [ ] Add an MCP integration test using the official client/inspector.
- [ ] Add structured audit logging with task id and tool names (never file bodies by default).
- [ ] Test project/session switching in Pi.
- [ ] Add concurrency tests for multiple planning tasks.

## V1 — plan approval + Pi execution (implemented)

V0.1 frozen baseline: `58d5456857b6f4cca849a279543c549fd9fc6c66`.

Lifecycle: `planning -> plan_received -> awaiting_approval -> approved -> executing -> execution_completed`.
Users explicitly approve with `/chatgpt-plan-approve <task-id>` or reject with `/chatgpt-plan-reject <task-id>`. Pi is sole executor; ChatGPT remains read/planner-only. No commit, push, deploy, or V2 review loop.

### V1 implementation notes

V1 starts only after V0.1 manual verification confirms session settings and identity capture.

- [x] Add explicit approval/rejection gate.
- [x] Inject accepted plan into Pi as external architect contract.
- [ ] Tell Pi not to redesign unless execution proves a concrete conflict.
- [x] Capture deviations from plan.
- [x] Persist execution summary and test commands/results.
- [x] No autonomous review loop yet.

## V2 — independent ChatGPT review

Add read-only MCP tools/state:

- [ ] `test_status`
- [ ] `execution_summary`

Add protocol write:

- [ ] `submit_review`

Flow:

```text
ChatGPT PLAN
  -> Pi IMPLEMENT
  -> Pi TEST
  -> ChatGPT reads actual git_diff/test_status
  -> APPROVED or CHANGES_REQUESTED
  -> Pi FIX
```

Require a maximum review/fix iteration count.

## V3 — optional `/feature --auto`

- [ ] Compose plan, execute, review, and bounded fix loop.
- [ ] Preserve user interruption/approval controls.
- [ ] Never automatically commit/push/deploy unless separately enabled and confirmed.

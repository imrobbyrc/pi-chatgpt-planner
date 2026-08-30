# Handoff snapshot

## V0.1 status

V0 transport remains proven. V0.1 adds defensive isolated browser sessions; execution/review are not implemented.

Each `/chatgpt-plan` creates a new CDP target at `https://chatgpt.com/`, leaves active conversation untouched, and persists target id immediately. It confirms fresh state, Personalized Temporary Chat, and High reasoning before attaching Pi Workspace, sending existing prompt with exact task id, and waiting for `submit_plan`.

```text
Pi -> Dia CDP 127.0.0.1:9222 -> new ChatGPT conversation
  -> Temporary + Personalized + High (all confirmed before prompt)
  -> Pi Workspace app -> task-id prompt
  -> OpenAI Secure MCP Tunnel / tunnel-client
  -> local MCP 127.0.0.1:8765/mcp -> submit_plan -> Pi
```

## State

`PlannerTask.chat` stores:

- `targetId` immediately after CDP target creation;
- `conversationUrl` when available;
- `conversationId` parsed from `/c/<id>`;
- `temporary`, `personalized` booleans;
- `reasoning: "high" | "unknown"`.

Browser only inspects controls, composer/app attachment state, and URL. It never scrapes assistant output.

## Manual verification

1. Start Dia with dedicated profile and CDP `127.0.0.1:9222`.
2. Leave any existing ChatGPT conversation open.
3. Configure `tunnel-client` and Pi Workspace against local `http://127.0.0.1:8765/mcp` route.
4. Run `/chatgpt-plan <harmless task>`.
5. Confirm new tab/conversation, Temporary + Personalized, High reasoning, and Pi Workspace attachment.
6. Confirm exact task id appears in planning request and `submit_plan` completes.
7. Inspect task JSON for `chat` URL/id and confirm project source is unchanged.

## Known fragility

ChatGPT control labels, selection ARIA state, app-chip markup, and delayed URL navigation can change. Unconfirmed settings generate warnings and require manual selection. Conversation identity is captured only when URL exposes it.

## Next

Finish real UI verification. Then design V1 confirmation gate and Pi-only execution. Do not implement V2 review yet.

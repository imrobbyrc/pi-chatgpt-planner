import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptBrowserController, assertPlannerState, extractConversationId } from "../src/browser/chatgpt.js";
import type { PlannerConfig, PlannerTask } from "../src/types.js";

test("extracts conversation identity from ChatGPT URL", () => {
  assert.equal(
    extractConversationId("https://chatgpt.com/c/abc-123?model=gpt"),
    "abc-123"
  );
  assert.equal(extractConversationId("https://chatgpt.com/"), undefined);
});

test("planner state is fail-closed", () => {
  assert.throws(() => assertPlannerState({ temporary: false, personalized: true, reasoning: "high" }), /Temporary/);
  assert.throws(() => assertPlannerState({ temporary: true, personalized: false, reasoning: "high" }), /Personalized/);
  assert.throws(() => assertPlannerState({ temporary: true, personalized: true, reasoning: "unknown" }), /High/);
  assert.doesNotThrow(() => assertPlannerState({ temporary: true, personalized: true, reasoning: "high" }));
});

test("creates target, persists identity before connect, and sends there", async () => {
  const events: string[] = [];
  let temporaryReads = 0;
  let personalizationReads = 0;
  let reasoningReads = 0;
  const temporaryLabels: string[] = [];
  const target = { id: "planner-target", type: "page", url: "https://chatgpt.com/" };
  const evaluate = async ({ expression }: { expression: string }) => {
    if (expression === "document.readyState") return { result: { value: "complete" } };
    if (expression.includes("document.readyState") && expression.includes("button:")) return { result: { value: { ready: "complete", button: true } } };
    if (expression.includes('button[aria-haspopup="menu"]') && expression.includes("map(el => el.getAttribute")) {
      personalizationReads += 1;
      return { result: { value: personalizationReads === 1 ? "Unpersonalized" : "Personalized" } };
    }
    if (expression.includes('button.click()') || expression.includes('trigger.click()') || expression.includes('option.click()') || expression.includes('item.click()')) return { result: { value: true } };
    if (expression.includes('owner.dispatchEvent')) { sliderValue = 2; return { result: { value: { keydown: true, keyup: true } } }; }
    if (expression.includes('owner.focus()')) return { result: { value: true } };
    if (expression.includes('const owner')) return { result: { value: { found: true, ariaLabel: "Power", shortcuts: "ArrowLeft ArrowRight" } } };
    if (expression.includes('data-model-reasoning-effort-slider')) return { result: { value: { found: true, min: "0", max: "3", value: String(sliderValue) } } };
    if (expression.includes('role="menuitemradio"') && expression.includes(".truncate")) {
      return { result: { value: { found: true, ariaChecked: "false", dataState: "unchecked", x: 10, y: 10 } } };
    }
    if (expression.includes("trigger.getAttribute('aria-expanded')")) return { result: { value: { focused: true, keydown: true, keyup: true, expanded: true, open: true } } };
    if (expression.includes('data-composer-transition-slot') && expression.includes('slotFound')) {
      const trigger = sliderValue === 2 ? "High" : "Medium";
      return { result: { value: { slotFound: true, candidates: [{ text: trigger, ariaExpanded: "true", dataState: "open", visible: true }], trigger } } };
    }
    if (expression.includes("aria-expanded") && expression.includes("data-state")) return { result: { value: true } };
    if (expression.includes('data-composer-transition-slot')) {
      reasoningReads += 1;
      return { result: { value: reasoningReads === 1 ? "Medium" : "High" } };
    }
    if (expression.includes('use[href$="#chat-temp-checked"]')) {
      temporaryReads += 1;
      const enabled = temporaryReads > 1;
      temporaryLabels.push(enabled ? "Turn off temporary chat" : "Temporary chat");
      return { result: { value: { found: true, enabled, ariaLabel: temporaryLabels.at(-1) } } };
    }
    if (expression.includes("location.href")) return { result: { value: "https://chatgpt.com/c/new-id" } };
    if (expression.includes("composer?.textContent")) return { result: { value: { currentUrl: "https://chatgpt.com/", composerText: "" } } };
    if (expression.includes("signals: []")) return { result: { value: { signals: ["Pi Workspace"] } } };
    return { result: { value: true } };
  };
  const fakeCdp = Object.assign(async ({ target: received }: { target: typeof target }) => {
    events.push(`connect:${received.id}`);
    return { Page: { enable: async () => undefined }, Runtime: { enable: async () => undefined, evaluate }, Input: { insertText: async () => events.push("insert"), dispatchKeyEvent: async (event: { key?: string }) => { if (event.key) events.push(`key:${event.key}`); if (event.key === "ArrowRight") sliderValue = 2; } }, close: async () => undefined };
  }, { New: async () => { events.push("new"); return target; } }) as any;
  let personalized = false;
  let sliderValue = 1;
  const locator = (selector = ""): any => ({
    count: async () => selector.includes("Personalized") ? (personalized ? 1 : 0) : selector.includes("Unpersonalized") ? (personalized ? 0 : 1) : 1,
    nth: () => locator(selector), first: () => locator(selector), last: () => locator(selector), filter: () => locator(selector), locator: (child: string) => locator(`${selector} ${child}`),
    isVisible: async () => !selector.includes("composer-intelligence-picker-content"),
    waitFor: async () => selector.includes('role="menuitemradio"') && selector.includes('composer-intelligence') ? new Promise(() => undefined) : undefined,
    click: async () => { if (selector.includes("Unpersonalized")) personalized = true; },
    getAttribute: async (name: string) => name === "aria-expanded" ? "false" : name === "aria-controls" ? null : name === "aria-valuemin" ? "0" : name === "aria-valuemax" ? "3" : name === "aria-valuenow" ? String(sliderValue) : null,
    textContent: async () => selector.includes("model-switcher") || selector.includes("data-tone") ? (sliderValue === 2 ? "High" : "Medium") : "",
    press: async (key: string) => { if (key === "ArrowRight") sliderValue = 2; },
    fill: async () => undefined
  });
  const fakePlaywright = (async () => ({
    contexts: () => [{ pages: () => [] }],
    close: async () => undefined
  })) as any;
  const fakePage: any = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    locator,
    getByRole: (role: string, options: { name: string }) => locator(`button[aria-label="${options.name}"]`),
    getByText: () => ({ last: () => ({ isVisible: async () => false }) }),
    keyboard: { insertText: async () => undefined, press: async () => undefined },
    waitForFunction: async () => undefined
  };
  fakePlaywright.connect = undefined;
  const connect = (async () => ({ contexts: () => [{ pages: () => [fakePage] }], close: async () => undefined })) as any;
  const task = { id: "123e4567-e89b-12d3-a456-426614174000", request: "task", workspaceRoot: "/tmp", createdAt: "", updatedAt: "", status: "planning" } as PlannerTask;
  const config = { cdpHost: "127.0.0.1", cdpPort: 9222, chatgptUrl: "https://chatgpt.com/", chatgptAppName: "Pi Workspace", browserAutoAttachApp: true } as PlannerConfig;
  const result = await new ChatGptBrowserController(config, fakeCdp).sendPlanningRequest(task, async (id) => { events.push(`persist:${id}`); });
  assert.deepEqual(events.slice(0, 3), ["new", "persist:planner-target", "connect:planner-target"]);
  assert.equal(result.chat.targetId, "planner-target");
  assert.equal(sliderValue, 2);
});

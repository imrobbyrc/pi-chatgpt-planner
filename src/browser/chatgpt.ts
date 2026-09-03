import CDP from "chrome-remote-interface";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatSessionMetadata, PlannerConfig, PlannerTask } from "../types.js";

export interface BrowserSendResult {
  attachedApp: boolean;
  url: string;
  chat: ChatSessionMetadata;
  warnings: string[];
}

export interface AppAttachmentSnapshot {
  signals: string[];
}

export interface BrowserDebugReport {
  createdAt: string;
  targetId: string;
  url: string;
  title: string;
  elements: unknown[];
}

export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]'
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])'
].join(", ");
export const CHATGPT_EFFORT_SLIDER_SELECTOR = '[data-model-reasoning-effort-slider] [role="slider"]';
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;

export function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(minRaw: string | null, maxRaw: string | null, valueRaw: string | null): { min: number; max: number; value: number } | undefined {
  const min = safeIntegerAttribute(minRaw);
  const max = safeIntegerAttribute(maxRaw);
  const value = safeIntegerAttribute(valueRaw);
  const count = min === undefined || max === undefined ? 0 : max - min + 1;
  if (min === undefined || max === undefined || value === undefined || count < 1 || count > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS || value < min || value > max) return undefined;
  return { min, max, value };
}

export interface FreshChatSnapshot {
  currentUrl: string;
  composerText: string;
  previousConversationId?: string;
}

export function assertPlannerState(state: {
  temporary: boolean;
  personalized: boolean;
  reasoning: "high" | "unknown";
}): void {
  if (!state.temporary) {
    throw new Error("ChatGPT Temporary Chat could not be confirmed. Enable Temporary Chat in newly-created planner tab, then retry.");
  }
  if (!state.personalized) {
    throw new Error("Personalized Temporary Chat could not be confirmed. Select Personalized before continuing, then retry.");
  }
  if (state.reasoning !== "high") {
    throw new Error("ChatGPT High reasoning could not be confirmed. Select High and verify selector shows High, then retry.");
  }
}

export function isFreshChatState(snapshot: FreshChatSnapshot): boolean {
  const currentId = extractConversationId(snapshot.currentUrl);
  const leftPreviousConversation = snapshot.previousConversationId
    ? currentId !== snapshot.previousConversationId
    : !currentId;
  return leftPreviousConversation && snapshot.composerText.trim().length === 0;
}

/** Matches app-chip/mention labels, not ChatGPT response text. */
export function isAppAttachmentConfirmed(snapshot: AppAttachmentSnapshot, appName: string): boolean {
  const name = appName.trim().toLowerCase();
  return Boolean(name) && snapshot.signals.some((signal) => signal.toLowerCase().includes(name));
}

export function extractConversationId(url: string): string | undefined {
  return url.match(/\/c\/([^/?#]+)/i)?.[1];
}

function plannerPrompt(task: PlannerTask, appName: string): string {
  return [
    `[PI-PLANNER:${task.id}]`,
    "",
    "Act as the external planning architect for this Pi coding task.",
    `Task: ${task.request}`,
    "",
    `Use the \"${appName}\" MCP app and inspect the real workspace before proposing a plan.`,
    `Every workspace tool call must use task_id: ${task.id}`,
    "Before finalizing, call list_active_methods and list_agent_skills; fetch only relevant active method/skill content with get_method_context/get_agent_skill.",
    "Active methods are controlled by Pi/user state; do not activate or change them.",
    task.requestedExecutionMode === "herdr" ? "This is explicit Herdr multi-agent planning. Return execution.mode=herdr, worker_model=luna-max, and a bounded 1-4 worker decomposition with objectives, owns scopes, and depends_on DAG." : "This is normal single-agent planning. Do not add Herdr execution metadata." ,
    "Include only relevant context names in submit_plan.context (methods and skills).",
    "Do not write source code and do not ask Pi to trust an uninspected plan.",
    "Inspect enough relevant files to understand the existing architecture, conventions, tests, and constraints.",
    "When the plan is complete, call submit_plan with a concise summary, detailed plan_markdown, files_to_inspect, acceptance_criteria, tests, risks, and open_questions.",
    "Do not paste the plan back through browser automation; submit_plan is the handoff back to Pi."
  ].join("\n");
}

export class ChatGptBrowserController {
  constructor(
    private readonly config: PlannerConfig,
    private readonly cdp: typeof CDP = CDP
  ) {}

  async debugPlannerTab(): Promise<{ path: string; report: BrowserDebugReport }> {
    const target = await this.cdp.New({
      host: this.config.cdpHost,
      port: this.config.cdpPort,
      url: "https://chatgpt.com/"
    });
    const client = await this.cdp({ host: this.config.cdpHost, port: this.config.cdpPort, target });
    try {
      const { Page, Runtime } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await this.waitForComposer(Runtime);
      const result = await Runtime.evaluate({
        expression: `(() => {
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return el.offsetParent !== null && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const short = (value) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
          const relevant = (el) => {
            const rect = el.getBoundingClientRect();
            const metadata = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid')].join(' ').toLowerCase();
            return rect.top < innerHeight * .5 || /temporary|personal|reason|model|plugin|app|workspace|mcp/.test(metadata) || ['menu', 'menuitem', 'option', 'listbox', 'combobox'].includes(el.getAttribute('role') || '');
          };
          return [...document.querySelectorAll('header, nav, button, a, input, [role], [data-testid]')]
            .filter(el => visible(el) && relevant(el))
            .slice(0, 250)
            .map(el => {
              const rect = el.getBoundingClientRect();
              const item: Record<string, unknown> = {
                tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), ariaLabel: el.getAttribute('aria-label'),
                ariaPressed: el.getAttribute('aria-pressed'), ariaSelected: el.getAttribute('aria-selected'), ariaChecked: el.getAttribute('aria-checked'),
                title: el.getAttribute('title'), dataTestId: el.getAttribute('data-testid'), text: short(el.textContent),
                box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, visible: true
              };
              if (el instanceof HTMLAnchorElement && el.href) item.href = el.href;
              return item;
            });
        })()`,
        returnByValue: true
      });
      const meta = await Runtime.evaluate({ expression: "({ url: location.href, title: document.title })", returnByValue: true });
      const value = meta.result.value as { url?: string; title?: string } | undefined;
      const report: BrowserDebugReport = {
        createdAt: new Date().toISOString(), targetId: target.id, url: value?.url ?? this.config.chatgptUrl,
        title: value?.title ?? "", elements: (result.result.value as unknown[]) ?? []
      };
      const dir = join(this.config.stateDir, "debug");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `chatgpt-${Date.now()}-${target.id}.json`);
      await writeFile(path, `${JSON.stringify(report, null, 2)}\\n`, "utf8");
      return { path, report };
    } finally {
      await client.close();
    }
  }

  async sendPlanningRequest(
    task: PlannerTask,
    onTargetCreated?: (targetId: string) => Promise<void>
  ): Promise<BrowserSendResult> {
    // Never attach to or navigate an existing tab. New target is isolation boundary.
    const target = await this.cdp.New({
      host: this.config.cdpHost,
      port: this.config.cdpPort,
      url: "https://chatgpt.com/"
    });
    if (!target.id) throw new Error("CDP created planner tab without targetId; no prompt was sent.");
    this.logDiagnostic(`targetId immediately after Target.createTarget: ${target.id}`);
    this.logDiagnostic(`target URL: ${target.url}`);
    this.logDiagnostic(`target title: ${target.title}`);
    await onTargetCreated?.(target.id);
    const client = await this.cdp({
      host: this.config.cdpHost,
      port: this.config.cdpPort,
      target
    });
    this.logDiagnostic(`CDP session attached to targetId: ${target.id}`);

    try {
      const { Page, Runtime, Input } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await this.logReadyState(Runtime);
      await this.waitForPlannerPage(Runtime);
      await this.waitForComposer(Runtime);
      if (!isFreshChatState(await this.freshChatSnapshot(Runtime))) {
        throw new Error("New ChatGPT planner tab was not in confirmed fresh state. No planning prompt was sent; retry.");
      }
      const temporary = await this.selectTemporaryChat(Runtime);
      if (!temporary) assertPlannerState({ temporary, personalized: false, reasoning: "unknown" });
      const personalized = await this.confirmPersonalized(Runtime, Input);
      if (!personalized) assertPlannerState({ temporary, personalized, reasoning: "unknown" });
      const reasoning = await this.selectHighReasoning(Runtime);
      assertPlannerState({ temporary, personalized, reasoning: reasoning ? "high" : "unknown" });
      const warnings: string[] = [];
      let attachedApp = false;
      if (this.config.browserAutoAttachApp) {
        attachedApp = await this.detectAppAttachment(Runtime, this.config.chatgptAppName);
        if (!attachedApp) attachedApp = await this.tryAttachApp(Runtime, Input, this.config.chatgptAppName);
      }
      if (!attachedApp) warnings.push(`Pi Workspace attachment was not confirmed; select "${this.config.chatgptAppName}" manually.`);
      await this.focusComposer(Runtime);
      await Input.insertText({ text: plannerPrompt(task, this.config.chatgptAppName) });
      await Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await new Promise((resolve) => setTimeout(resolve, 750));
      const url = await this.waitForConversationUrl(Runtime);
      const conversationId = extractConversationId(url);
      const chat: ChatSessionMetadata = { targetId: target.id, conversationUrl: url, temporary, personalized, reasoning: reasoning ? "high" : "unknown" };
      if (conversationId !== undefined) chat.conversationId = conversationId as string;
      return { attachedApp, url, warnings, chat };
    } finally {
      await client.close();
    }
  }

  /** V2: send a review-control prompt into the EXACT existing planner target. Never creates a
   *  target, never reruns Temporary/Personalized bootstrap. Fails closed if target vanished. */
  async sendPlanRevisionPrompt(task: PlannerTask, feedback: string, baseRevision: number): Promise<void> {
    const targetId = task.chat?.targetId;
    if (!targetId) throw new Error("planner_target_unavailable: task has no stored targetId");
    const mode = task.requestedExecutionMode === "herdr" ? " Preserve complete Herdr execution contract: fixed worker_model=luna-max, 1-4 workers, valid owns scopes, and acyclic depends_on." : " Preserve single-agent execution; do not add Herdr metadata.";
    const prompt = `[PI-PLAN-REVISION:${task.id}]\n\nRevise existing plan for task ${task.id}. This is revision ${baseRevision + 1}, based on current revision ${baseRevision}.${mode}\nUser feedback:\n${feedback}\n\nUse Pi Workspace read-only tools if needed. Do not create a new plan task or conversation. Submit complete revised plan through submit_plan_revision with task_id ${task.id}, base_revision ${baseRevision}, and the full plan. Preserve applicable method/skill context unless user explicitly changed it.`;
    await this.sendToExistingTarget(task, prompt);
  }

  async sendReviewPrompt(task: PlannerTask, prompt: string): Promise<void> {
    await this.sendToExistingTarget(task, prompt);
  }

  private async sendToExistingTarget(task: PlannerTask, prompt: string): Promise<void> {
    const targetId = task.chat?.targetId;
    if (!targetId) throw new Error("planner_target_unavailable: task has no stored targetId");
    let target: { id?: string; url?: string } | undefined;
    try {
      const targets = (await this.cdp.List({ host: this.config.cdpHost, port: this.config.cdpPort })) as { id?: string; url?: string }[];
      target = targets?.find((candidate) => candidate.id === targetId);
    } catch {
      target = undefined;
    }
    if (!target) throw new Error(`planner_target_unavailable: Original Temporary Chat is no longer available. This task cannot be reviewed by the same planner conversation. Create a new planning task if review is still required.`);
    const client = await this.cdp({ host: this.config.cdpHost, port: this.config.cdpPort, target: targetId });
    this.logDiagnostic(`Review CDP session attached to targetId: ${targetId}`);
    try {
      const { Page, Runtime, Input } = client;
      await Promise.all([Page.enable(), Runtime.enable()]);
      await this.logReadyState(Runtime);
      const url = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
      const href = String(url.result.value ?? "");
      let origin = "";
      try { origin = new URL(href).origin; } catch { /* invalid URL fails below */ }
      if (origin !== "https://chatgpt.com") {
        throw new Error(`planner_target_unavailable: target ${targetId} is not a chatgpt.com page (${href.slice(0, 60)})`);
      }
      await this.waitForComposer(Runtime);
      await this.focusComposer(Runtime);
      await Input.insertText({ text: prompt });
      await Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      this.logDiagnostic("Review prompt sent to original planner target");
    } finally {
      await client.close();
    }
  }

  private async logReadyState(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<void> {
    try {
      const result = await Runtime.evaluate({ expression: "document.readyState", returnByValue: true });
      this.logDiagnostic(`Runtime.evaluate document.readyState: ${String(result.result.value)}`);
    } catch (error) {
      this.logDiagnostic(`Runtime.evaluate document.readyState failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async waitForPlannerPage(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const result = await Runtime.evaluate({
          expression: `({ ready: document.readyState, button: Boolean(document.querySelector('button[aria-label="Temporary chat"], button[aria-label="Turn off temporary chat"]')) })`,
          returnByValue: true
        });
        const state = result.result.value as { ready?: string; button?: boolean } | undefined;
        if (state?.ready === "complete" && state.button === true) return;
      } catch (error) {
        if (!this.isDestroyedContext(error)) throw error;
        this.logDiagnostic(`Planner execution context unavailable; retrying: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("ChatGPT planner page did not reach readyState complete with Temporary control. No planning prompt was sent.");
  }

  private isDestroyedContext(error: unknown): boolean {
    return /destroyed|execution context|cannot find context|target closed/i.test(error instanceof Error ? error.message : String(error));
  }

  private async freshChatSnapshot(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]
  ): Promise<FreshChatSnapshot> {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const composer = [...document.querySelectorAll('[contenteditable="true"]')].find(el => el.offsetParent !== null);
        return { currentUrl: location.href, composerText: composer?.textContent || '' };
      })()`,
      returnByValue: true
    });
    const value = result.result.value as Omit<FreshChatSnapshot, "previousConversationId"> | undefined;
    return { currentUrl: value?.currentUrl ?? this.config.chatgptUrl, composerText: value?.composerText ?? "" };
  }

  private async selectTemporaryChat(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<boolean> {
    const before = await this.readTemporaryState(Runtime);
    this.logDiagnostic(`Temporary state before: ${JSON.stringify(before)}`);
    if (!before.found) {
      // AX/text fallback only covers UI variants without current semantic button.
      const fallback = await this.clickText(Runtime, "temporary chat");
      this.logDiagnostic(`Temporary click fallback issued: ${fallback}`);
      if (!fallback) return false;
    } else if (!before.enabled) {
      const clicked = await this.clickTemporaryButton(Runtime);
      this.logDiagnostic(`Temporary click issued: ${clicked}`);
      if (!clicked) return false;
    } else {
      this.logDiagnostic("Temporary click issued: false (already enabled)");
    }
    const confirmed = before.found
      ? await this.waitForTemporaryState(Runtime)
      : await this.waitForTemporaryState(Runtime) || await this.waitForSelectedText(Runtime, "temporary chat");
    const after = await this.readTemporaryState(Runtime);
    this.logDiagnostic(`Temporary state after: ${JSON.stringify(after)}`);
    this.logDiagnostic(`Temporary URL/navigation changed: ${after.url !== before.url} (${before.url} -> ${after.url})`);
    if (!confirmed) this.logDiagnostic("Temporary confirmation timed out after 2000ms: checked SVG did not become rendered.");
    this.logDiagnostic(`Temporary confirmation result: ${confirmed}`);
    return confirmed;
  }

  private async readTemporaryState(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]
  ): Promise<{ url: string; title: string; readyState: string; offButtonFound: boolean; onButtonFound: boolean; checkedIconFound: boolean; checkedOpacity?: string; checkedVisibility?: string; checkedDisplay?: string; found: boolean; enabled: boolean; ariaLabel?: string }> {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const off = document.querySelector('button[aria-label="Temporary chat"]');
        const on = document.querySelector('button[aria-label="Turn off temporary chat"]');
        const checked = document.querySelector('use[href$="#chat-temp-checked"]');
        const svg = checked?.closest('svg');
        const button = svg?.closest('button');
        const style = svg ? getComputedStyle(svg) : undefined;
        const enabled = Boolean(svg && style && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0);
        return {
          url: location.href, title: document.title, readyState: document.readyState,
          offButtonFound: Boolean(off), onButtonFound: Boolean(on), checkedIconFound: Boolean(checked),
          checkedOpacity: style?.opacity, checkedVisibility: style?.visibility, checkedDisplay: style?.display,
          found: Boolean(button), enabled, ariaLabel: button?.getAttribute('aria-label') || undefined
        };
      })()`,
      returnByValue: true
    });
    const value = result.result.value as Partial<Awaited<ReturnType<typeof this.readTemporaryState>>> | undefined;
    return {
      url: value?.url ?? this.config.chatgptUrl, title: value?.title ?? "", readyState: value?.readyState ?? "unknown",
      offButtonFound: value?.offButtonFound === true,
      onButtonFound: value?.onButtonFound === true, checkedIconFound: value?.checkedIconFound === true,
      ...(value?.checkedOpacity !== undefined ? { checkedOpacity: value.checkedOpacity } : {}),
      ...(value?.checkedVisibility !== undefined ? { checkedVisibility: value.checkedVisibility } : {}),
      ...(value?.checkedDisplay !== undefined ? { checkedDisplay: value.checkedDisplay } : {}),
      found: value?.found === true, enabled: value?.enabled === true, ...(value?.ariaLabel ? { ariaLabel: value.ariaLabel } : {})
    };
  }

  private async clickTemporaryButton(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]
  ): Promise<boolean> {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const checked = document.querySelector('use[href$="#chat-temp-checked"]');
        const button = checked?.closest('svg')?.closest('button');
        if (!button) return false;
        button.click();
        return true;
      })()`,
      returnByValue: true
    });
    return result.result.value === true;
  }

  private async confirmPersonalized(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"],
    Input: Awaited<ReturnType<typeof CDP>>["Input"]
  ): Promise<boolean> {
    const before = await this.readPersonalizationState(Runtime);
    this.logDiagnostic(`Personalization state before: ${before}`);
    if (before === "Personalized") return true;
    if (before !== "Unpersonalized") return false;

    const triggerClicked = await this.openPersonalization(Runtime);
    this.logDiagnostic(`Personalization trigger click issued: ${triggerClicked}`);
    const opened = await this.waitForPersonalizationMenu(Runtime);
    this.logDiagnostic(`Personalization chooser opened: ${opened}`);
    if (!opened) return false;

    const option = await this.findPersonalizedOption(Runtime);
    this.logDiagnostic(`Personalized option found: ${option.found}`);
    this.logDiagnostic(`Personalized option aria-checked before: ${option.ariaChecked ?? "unknown"}`);
    if (!option.found || option.ariaChecked !== "false" || option.dataState !== "unchecked") return false;

    let clicked = await this.clickPersonalizedOption(Runtime);
    this.logDiagnostic(`Personalized click issued: ${clicked}`);
    if (!clicked) return false;

    let after = "unknown";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      after = await this.readPersonalizationState(Runtime);
      this.logDiagnostic(`Personalization poll: ${after}`);
      if (after === "Personalized") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (after !== "Personalized" && option.x !== undefined && option.y !== undefined) {
      await Input.dispatchMouseEvent({ type: "mousePressed", x: option.x, y: option.y, button: "left", clickCount: 1 });
      await Input.dispatchMouseEvent({ type: "mouseReleased", x: option.x, y: option.y, button: "left", clickCount: 1 });
      clicked = true;
      this.logDiagnostic("Personalized pointer click issued: true");
      after = await this.readPersonalizationState(Runtime);
    }
    const confirmed = after === "Personalized";
    this.logDiagnostic(`Personalization state after: ${after}`);
    this.logDiagnostic(`Personalization confirmation result: ${confirmed}`);
    return confirmed;
  }

  private async readPersonalizationState(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<string> {
    const result = await Runtime.evaluate({ expression: `(() => [...document.querySelectorAll('button[aria-haspopup="menu"]')]
      .filter(el => el.offsetParent !== null)
      .map(el => el.getAttribute('aria-label'))
      .find(label => label === 'Personalized' || label === 'Unpersonalized') || 'unknown')()`, returnByValue: true });
    return typeof result.result.value === "string" ? result.result.value : "unknown";
  }

  private async openPersonalization(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<boolean> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"][aria-label="Unpersonalized"]')]
        .find(el => el.offsetParent !== null);
      if (!trigger) return false;
      trigger.click();
      return true;
    })()`, returnByValue: true });
    return result.result.value === true;
  }

  private async waitForPersonalizationMenu(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<boolean> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await Runtime.evaluate({ expression: `(() => Boolean([...document.querySelectorAll('[role="menuitemradio"]')].find(el => el.offsetParent !== null)))()`, returnByValue: true });
      if (result.result.value === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async findPersonalizedOption(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<{ found: boolean; ariaChecked?: string; dataState?: string; x?: number; y?: number }> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const item = [...document.querySelectorAll('[role="menuitemradio"]')].find(el => {
        if (el.offsetParent === null) return false;
        const label = el.querySelector('.truncate')?.textContent?.trim();
        return label === 'Personalized';
      });
      if (!item) return { found: false };
      const rect = item.getBoundingClientRect();
      return { found: true, ariaChecked: item.getAttribute('aria-checked'), dataState: item.getAttribute('data-state'), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`, returnByValue: true });
    const value = result.result.value as { found?: boolean; ariaChecked?: string; dataState?: string; x?: number; y?: number } | undefined;
    return {
      found: value?.found === true,
      ...(value?.ariaChecked !== undefined ? { ariaChecked: value.ariaChecked } : {}),
      ...(value?.dataState !== undefined ? { dataState: value.dataState } : {}),
      ...(value?.x !== undefined ? { x: value.x } : {}), ...(value?.y !== undefined ? { y: value.y } : {})
    };
  }

  private async clickPersonalizedOption(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<boolean> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const item = [...document.querySelectorAll('[role="menuitemradio"]')].find(el => el.offsetParent !== null && el.querySelector('.truncate')?.textContent?.trim() === 'Personalized');
      if (!item) return false;
      item.click();
      return true;
    })()`, returnByValue: true });
    return result.result.value === true;
  }

  private async waitForTemporaryState(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]
  ): Promise<boolean> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      // Re-query DOM every poll; never retain button/SVG handles.
      try {
        const state = await this.readTemporaryState(Runtime);
        this.logDiagnostic(`Temporary poll: ${JSON.stringify({ url: state.url, offButtonFound: state.offButtonFound, onButtonFound: state.onButtonFound, checkedIconFound: state.checkedIconFound, checkedOpacity: state.checkedOpacity, enabled: state.enabled })}`);
        if (state.enabled) return true;
      } catch (error) {
        if (!this.isDestroyedContext(error)) throw error;
        this.logDiagnostic(`Temporary poll execution context unavailable; retrying: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async selectHighReasoning(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]
  ): Promise<boolean> {
    this.logDiagnostic("Reasoning bootstrap started: true");
    const before = await this.waitForReasoningTrigger(Runtime);
    this.logDiagnostic(`Reasoning state before: ${before}`);
    if (before === "High") {
      this.logDiagnostic("Reasoning confirmation result: true");
      return true;
    }
    if (before !== "Medium") return false;

    let activation = await this.openReasoningMenu(Runtime);
    if (!activation.open) {
      const opened = await this.waitForReasoningMenuOpen(Runtime);
      activation = { ...activation, expanded: opened, open: opened };
    }
    this.logDiagnostic(`Reasoning trigger focused: ${activation.focused}`);
    this.logDiagnostic(`Reasoning Enter keydown dispatched: ${activation.keydown}`);
    this.logDiagnostic(`Reasoning Enter keyup dispatched: ${activation.keyup}`);
    this.logDiagnostic(`Reasoning trigger aria-expanded: ${activation.expanded}`);
    this.logDiagnostic(`Reasoning menu opened: ${activation.open}`);
    if (!activation.open) return false;
    const slider = await this.waitForEffortSlider(Runtime);
    this.logDiagnostic(`Reasoning slider found: ${slider.found}`);
    if (!slider.found) return false;
    const state = parseChatGptEffortSliderState(slider.min, slider.max, slider.value);
    if (!state) return false;
    const target = state.min + 2;
    this.logDiagnostic(`Slider min: ${state.min}`);
    this.logDiagnostic(`Slider max: ${state.max}`);
    this.logDiagnostic(`Slider value before: ${state.value}`);
    this.logDiagnostic(`Slider target: ${target}`);
    if (target > state.max) return false;
    const owner = await this.readSliderOwner(Runtime);
    this.logDiagnostic(`Slider owner found: ${owner.found}`);
    this.logDiagnostic(`Slider owner aria-label: ${owner.ariaLabel ?? "unknown"}`);
    this.logDiagnostic(`Slider owner shortcuts: ${owner.shortcuts ?? "unknown"}`);
    if (!owner.found) return false;

    let current = state.value;
    while (current !== target) {
      const direction = target > current ? 1 : -1;
      const previous = current;
      const focused = await this.focusSliderOwner(Runtime);
      this.logDiagnostic(`Slider owner focused: ${focused}`);
      if (!focused) return false;
      const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
      const dispatched = await this.dispatchSliderKey(Runtime, key);
      this.logDiagnostic(`${key} keydown dispatched: ${dispatched.keydown}`);
      this.logDiagnostic(`${key} keyup dispatched: ${dispatched.keyup}`);
      if (!dispatched.keydown || !dispatched.keyup) return false;
      const deadline = Date.now() + 5_000;
      let next: { min: number; max: number; value: number } | undefined;
      while (Date.now() < deadline) {
        const fresh = await this.readGlobalEffortSlider(Runtime);
        next = parseChatGptEffortSliderState(fresh.min, fresh.max, fresh.value);
        if (next && next.value !== previous) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!next || next.value !== previous + direction) {
        this.logDiagnostic(`Reasoning bootstrap failed: slider moved unexpectedly (${previous} -> ${next?.value ?? "unknown"}; expected ${previous + direction})`);
        return false;
      }
      current = next.value;
      this.logDiagnostic(`Slider value after: ${current}`);
    }
    const closed = await this.closeReasoningMenu(Runtime);
    this.logDiagnostic(`Reasoning popup closed: ${closed}`);
    if (!closed) return false;
    const after = await this.waitForReasoningTrigger(Runtime);
    this.logDiagnostic(`Reasoning state after: ${after}`);
    const confirmed = after === "High";
    this.logDiagnostic(`Reasoning confirmation result: ${confirmed}`);
    return confirmed;
  }

  private async waitForReasoningTrigger(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<string> {
    const deadline = Date.now() + 3_000;
    let lastStage = "trailing slot unavailable";
    while (Date.now() < deadline) {
      const result = await Runtime.evaluate({ expression: `(() => {
        const slots = [...document.querySelectorAll('[data-composer-transition-slot="trailing"]')];
        const candidates = slots.flatMap(slot => [...slot.querySelectorAll('button[aria-haspopup="menu"]')]).map(el => ({
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(), ariaExpanded: el.getAttribute('aria-expanded'), dataState: el.getAttribute('data-state'), visible: el.offsetParent !== null
        }));
        const trigger = candidates.find(candidate => candidate.visible && (candidate.text === 'Medium' || candidate.text === 'High'));
        return { slotFound: slots.length > 0, candidates, trigger: trigger?.text || 'unknown' };
      })()`, returnByValue: true });
      const state = result.result.value as { slotFound?: boolean; candidates?: unknown[]; trigger?: string } | undefined;
      const candidates = state?.candidates ?? [];
      this.logDiagnostic(`Reasoning trailing slot found: ${state?.slotFound === true}`);
      this.logDiagnostic(`Reasoning trigger candidates: ${JSON.stringify(candidates)}`);
      this.logDiagnostic(`Reasoning trigger found: ${state?.trigger === 'Medium' || state?.trigger === 'High'}`);
      if (state?.trigger === 'Medium' || state?.trigger === 'High') return state.trigger;
      lastStage = state?.slotFound ? "reasoning trigger unavailable" : "trailing slot unavailable";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.logDiagnostic(`Reasoning bootstrap failed: ${lastStage}`);
    return "unknown";
  }

  private async readReasoningState(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<string> {
    const result = await Runtime.evaluate({ expression: `(() => [...document.querySelectorAll('[data-composer-transition-slot="trailing"] button[aria-haspopup="menu"]')]
      .filter(el => el.offsetParent !== null)
      .map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim())
      .find(text => text === 'Medium' || text === 'High') || 'unknown')()`, returnByValue: true });
    return typeof result.result.value === "string" ? result.result.value : "unknown";
  }

  private async openReasoningMenu(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<{ focused: boolean; keydown: boolean; keyup: boolean; expanded: boolean; open: boolean }> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const trigger = [...document.querySelectorAll('[data-composer-transition-slot="trailing"] button[aria-haspopup="menu"]')]
        .find(el => el.offsetParent !== null && ['Medium', 'High'].includes((el.textContent || '').replace(/\\s+/g, ' ').trim()));
      if (!trigger) return { focused: false, keydown: false, keyup: false, expanded: false, open: false };
      trigger.focus();
      const focused = document.activeElement === trigger;
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      const expanded = trigger.getAttribute('aria-expanded') === 'true';
      return { focused, keydown: true, keyup: true, expanded, open: expanded && (trigger.getAttribute('data-state') || 'open') === 'open' };
    })()`, returnByValue: true });
    const value = result.result.value as { focused?: boolean; keydown?: boolean; keyup?: boolean; expanded?: boolean; open?: boolean } | undefined;
    return { focused: value?.focused === true, keydown: value?.keydown === true, keyup: value?.keyup === true, expanded: value?.expanded === true, open: value?.open === true };
  }

  private async waitForReasoningMenuOpen(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<boolean> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await Runtime.evaluate({ expression: `(() => [...document.querySelectorAll('[data-composer-transition-slot="trailing"] button[aria-haspopup="menu"]')].some(el => el.offsetParent !== null && el.getAttribute('aria-expanded') === 'true' && (el.getAttribute('data-state') || 'open') === 'open'))()`, returnByValue: true });
      if (result.result.value === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async waitForEffortSlider(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<{ found: boolean; min: string | null; max: string | null; value: string | null }> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const slider = await this.readGlobalEffortSlider(Runtime);
      if (slider.found) return slider;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { found: false, min: null, max: null, value: null };
  }

  private async readGlobalEffortSlider(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<{ found: boolean; min: string | null; max: string | null; value: string | null }> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const slider = document.querySelector('[data-model-reasoning-effort-slider] [role="slider"]');
      return { found: Boolean(slider), min: slider?.getAttribute('aria-valuemin') || null, max: slider?.getAttribute('aria-valuemax') || null, value: slider?.getAttribute('aria-valuenow') || null };
    })()`, returnByValue: true });
    const value = result.result.value as { found?: boolean; min?: string | null; max?: string | null; value?: string | null } | undefined;
    return { found: value?.found === true, min: value?.min ?? null, max: value?.max ?? null, value: value?.value ?? null };
  }

  private async readSliderOwner(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<{ found: boolean; ariaLabel?: string; shortcuts?: string }> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const slider = document.querySelector('[data-model-reasoning-effort-slider] [role="slider"]');
      const owner = slider?.closest('[role="menuitem"]');
      return { found: Boolean(owner), ariaLabel: owner?.getAttribute('aria-label') || undefined, shortcuts: owner?.getAttribute('aria-keyshortcuts') || undefined };
    })()`, returnByValue: true });
    const value = result.result.value as { found?: boolean; ariaLabel?: string; shortcuts?: string } | undefined;
    return { found: value?.found === true, ...(value?.ariaLabel ? { ariaLabel: value.ariaLabel } : {}), ...(value?.shortcuts ? { shortcuts: value.shortcuts } : {}) };
  }

  private async focusSliderOwner(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<boolean> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const slider = document.querySelector('[data-model-reasoning-effort-slider] [role="slider"]');
      const owner = slider?.closest('[role="menuitem"]');
      if (!owner) return false;
      owner.focus();
      return document.activeElement === owner;
    })()`, returnByValue: true });
    return result.result.value === true;
  }

  private async dispatchSliderKey(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"], key: "ArrowRight" | "ArrowLeft"): Promise<{ keydown: boolean; keyup: boolean }> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const slider = document.querySelector('[data-model-reasoning-effort-slider] [role="slider"]');
      const owner = slider?.closest('[role="menuitem"]');
      if (!owner) return { keydown: false, keyup: false };
      owner.focus();
      const key = ${JSON.stringify(key)};
      owner.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
      owner.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }));
      return { keydown: true, keyup: true };
    })()`, returnByValue: true });
    const value = result.result.value as { keydown?: boolean; keyup?: boolean } | undefined;
    return { keydown: value?.keydown === true, keyup: value?.keyup === true };
  }

  private async closeReasoningMenu(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<boolean> {
    const result = await Runtime.evaluate({ expression: `(() => {
      const active = document.activeElement;
      if (!active) return false;
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      active.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return true;
    })()`, returnByValue: true });
    return result.result.value === true;
  }

  private logDiagnostic(message: string): void {
    console.info(`[pi-chatgpt-planner] ${message}`);
  }

  private async clickAndConfirm(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"],
    label: string,
    confirmation: string
  ): Promise<boolean> {
    await this.clickText(Runtime, label);
    return this.waitForSelectedText(Runtime, confirmation);
  }

  private async clickText(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"], label: string): Promise<boolean> {
    const escaped = JSON.stringify(label.toLowerCase());
    const result = await Runtime.evaluate({
      expression: `(() => {
        const label = ${escaped};
        const nodes = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [data-radix-collection-item]')]
          .filter(el => el.offsetParent !== null)
          .filter(el => (el.textContent || '').trim().toLowerCase().includes(label));
        const node = nodes[0];
        if (!node) return false;
        node.click();
        return true;
      })()`,
      returnByValue: true
    });
    return result.result.value === true;
  }

  private async hasSelectedText(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"], text: string): Promise<boolean> {
    const escaped = JSON.stringify(text.toLowerCase());
    const result = await Runtime.evaluate({
      expression: `(() => [...document.querySelectorAll('[aria-checked="true"], [aria-selected="true"], [aria-pressed="true"], [data-state="checked"], [data-selected="true"]')]
        .filter(el => el.offsetParent !== null)
        .some(el => (el.textContent || '').toLowerCase().includes(${escaped}) || (el.getAttribute('aria-label') || '').toLowerCase().includes(${escaped}) || (el.getAttribute('title') || '').toLowerCase().includes(${escaped})))()`,
      returnByValue: true
    });
    return result.result.value === true;
  }

  private async waitForSelectedText(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"],
    text: string,
    allowSelectorReadback = false
  ): Promise<boolean> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (await this.hasSelectedText(Runtime, text)) return true;
      if (allowSelectorReadback && await this.hasVisibleSelectorText(Runtime, text)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async hasVisibleSelectorText(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"],
    text: string
  ): Promise<boolean> {
    const escaped = JSON.stringify(text.toLowerCase());
    const result = await Runtime.evaluate({
      expression: `(() => [...document.querySelectorAll('button')]
        .filter(el => el.offsetParent !== null && !el.getAttribute('aria-haspopup'))
        .some(el => (el.textContent || '').trim().toLowerCase().includes(${escaped}) || (el.getAttribute('aria-label') || '').toLowerCase().includes(${escaped})))()`,
      returnByValue: true
    });
    return result.result.value === true;
  }

  private async waitForConversationUrl(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<string> {
    const deadline = Date.now() + 3_000;
    let url = this.config.chatgptUrl;
    while (Date.now() < deadline) {
      url = await this.currentUrl(Runtime);
      if (extractConversationId(url)) return url;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return url;
  }

  private async currentUrl(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<string> {
    const result = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return typeof result.result.value === "string" ? result.result.value : this.config.chatgptUrl;
  }

  private async waitForComposer(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const result = await Runtime.evaluate({
        expression: `(() => Boolean([...document.querySelectorAll('[contenteditable="true"]')].find(el => el.offsetParent !== null)))()`,
        returnByValue: true
      });
      if (result.result.value === true) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("ChatGPT composer not found. Ensure the configured Browser/CDP profile is logged in to chatgpt.com.");
  }

  private async focusComposer(Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"]): Promise<void> {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const items = [...document.querySelectorAll('[contenteditable="true"]')].filter(el => el.offsetParent !== null);
        const el = items.at(-1);
        if (!el) return false;
        el.focus();
        return true;
      })()`,
      returnByValue: true
    });
    if (result.result.value !== true) throw new Error("Unable to focus ChatGPT composer");
  }

  private async detectAppAttachment(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"],
    appName: string
  ): Promise<boolean> {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const composer = [...document.querySelectorAll('[contenteditable="true"]')].find(el => el.offsetParent !== null);
        if (!composer) return { signals: [] };
        const container = composer.closest('form') || composer.parentElement?.parentElement || composer;
        const nodes = [composer, ...container.querySelectorAll('[data-mention], [data-app], [data-type], [aria-label], [title]')];
        return { signals: nodes.flatMap(el => [el.textContent || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('data-mention') || '', el.getAttribute('data-app') || '', el.getAttribute('data-type') || '']) };
      })()`,
      returnByValue: true
    });
    return isAppAttachmentConfirmed((result.result.value as AppAttachmentSnapshot | undefined) ?? { signals: [] }, appName);
  }

  private async tryAttachApp(
    Runtime: Awaited<ReturnType<typeof CDP>>["Runtime"],
    Input: Awaited<ReturnType<typeof CDP>>["Input"],
    appName: string
  ): Promise<boolean> {
    await this.focusComposer(Runtime);
    await Input.insertText({ text: `@${appName}` });
    await new Promise((resolve) => setTimeout(resolve, 700));

    const escaped = JSON.stringify(appName.toLowerCase());
    const result = await Runtime.evaluate({
      expression: `(() => {
        const name = ${escaped};
        const candidates = [...document.querySelectorAll('[role="option"], [role="menuitem"], button, [data-radix-collection-item]')]
          .filter(el => el.offsetParent !== null)
          .filter(el => (el.textContent || '').trim().toLowerCase().includes(name));
        const match = candidates[0];
        if (!match) return false;
        match.click();
        return true;
      })()`,
      returnByValue: true
    });

    let attached = result.result.value === true;
    if (attached) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      attached = await this.detectAppAttachment(Runtime, appName);
    }
    if (!attached) {
      // Remove the literal @mention so the actual planning prompt stays clean.
      await Runtime.evaluate({
        expression: `(() => {
          const items = [...document.querySelectorAll('[contenteditable="true"]')].filter(el => el.offsetParent !== null);
          const el = items.at(-1);
          if (!el) return false;
          el.focus();
          document.execCommand('selectAll', false);
          document.execCommand('delete', false);
          return true;
        })()`,
        returnByValue: true
      });
    } else {
      await Input.insertText({ text: "\n" });
    }
    return attached;
  }
}

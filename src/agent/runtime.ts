import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ApprovalService } from "../approvals/service.ts";
import type { Repo } from "../db/repo.ts";
import type { Logger } from "../logger.ts";
import type { PolicyRules } from "../policy/rules.ts";
import type { SandboxClient } from "./sandbox-client.ts";
import { createSandboxBackedTools, guardTools, type AgentTool, type RunContext, type RunTrigger } from "./tools.ts";

// Pi models are generic over their API type; the runtime handles any of them.
type AnyModel = Model<any>;

export interface RuntimeOptions {
  repo: Repo;
  log: Logger;
  rules: PolicyRules;
  sandbox: SandboxClient;
  approvals: ApprovalService;
  modelRuntime: ModelRuntime;
  /** Look up a model id (e.g. "deepseek/deepseek-v4.1-flash"). */
  resolveModel(id: string): AnyModel | undefined;
  defaultModel: string;
  dataDir: string;
  workspace: string;
  toolTimeoutSeconds: number;
  maxOutputChars: number;
  systemPrompt: string;
  /** Extra tools (memory, routines, browser, ...), built per session. */
  toolFactories?: ((getRun: () => RunContext | undefined) => AgentTool[])[];
  /** Text appended to the system prompt, re-read before every run (e.g. the owner's profile). */
  getPromptAddendum?: () => Promise<string>;
  redact?: (text: string) => string;
  modelMaxRetries?: number;
}

export interface RunHooks {
  onToolStart(description: string): void;
  onWaitingApproval(waiting: boolean): void | Promise<void>;
  sendImage?(image: Buffer, caption: string): Promise<void>;
  /** Called before every model call; return a reason to stop the run (budget). */
  beforeModelCall?(): Promise<string | undefined>;
}

export type StopReason = "user" | "limit";

export interface RunResult {
  text: string;
  aborted: boolean;
  /** Why the run was aborted: by the owner (/stop) or by a limit (budget, turns). */
  stopReason?: StopReason;
  stopMessage?: string;
  error?: string;
}

export interface RunInput {
  chatId: number;
  taskId: string;
  prompt: string;
  signal: AbortSignal;
  hooks: RunHooks;
  /** "chat" uses the chat's persistent session; "routine" a fresh session for this run only. */
  session: "chat" | "routine";
  trigger: RunTrigger;
  approvalTimeoutSeconds: number;
  maxTurns: number;
}

export async function loadSystemPrompt(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFile(path.join(here, "system-prompt.md"), "utf8");
}

/** Create the OpenRouter-backed model runtime. The key stays in memory only. */
export async function createOpenRouterRuntime(dataDir: string, apiKey: string): Promise<{
  modelRuntime: ModelRuntime;
  resolveModel: (id: string) => AnyModel | undefined;
}> {
  const piDir = path.join(dataDir, "pi");
  await mkdir(piDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(piDir, "auth.json"),
    modelsPath: path.join(piDir, "models.json"),
  });
  await modelRuntime.setRuntimeApiKey("openrouter", apiKey);
  return { modelRuntime, resolveModel: (id) => modelRuntime.getModel("openrouter", id) };
}

/** A resource loader that loads nothing from disk: no AGENTS.md, skills, prompts or extensions from /workspace. */
function isolatedResourceLoader(systemPrompt: string, addendum: () => string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => {
      const extra = addendum();
      return extra ? [extra] : [];
    },
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/**
 * Pi sessions: one persistent session per Telegram chat (JSONL under
 * DATA_DIR/sessions), plus a fresh session for each routine run (kept under
 * sessions/routines for the record) so routines don't pollute the chat.
 */
export class AgentRuntime {
  private readonly sessions = new Map<number, AgentSession>();
  private readonly runs = new Map<string, RunContext>();
  private readonly creating = new Map<number, Promise<AgentSession>>();
  private readonly sessionDir: string;
  private readonly archiveDir: string;
  private readonly routineDir: string;
  private addendum = "";

  constructor(private readonly opts: RuntimeOptions) {
    this.sessionDir = path.join(opts.dataDir, "sessions");
    this.archiveDir = path.join(this.sessionDir, "archive");
    this.routineDir = path.join(this.sessionDir, "routines");
  }

  async init(): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true });
    await mkdir(this.routineDir, { recursive: true });
  }

  modelIdFor(chatModel: string | null | undefined): string {
    return chatModel ?? this.opts.defaultModel;
  }

  hasModel(id: string): boolean {
    return this.opts.resolveModel(id) !== undefined;
  }

  private getChatSession(chatId: number): Promise<AgentSession> {
    const cached = this.sessions.get(chatId);
    if (cached) return Promise.resolve(cached);
    let pending = this.creating.get(chatId);
    if (!pending) {
      pending = this.createChatSession(chatId).finally(() => this.creating.delete(chatId));
      this.creating.set(chatId, pending);
    }
    return pending;
  }

  private async createChatSession(chatId: number): Promise<AgentSession> {
    const chat = await this.opts.repo.ensureChat(chatId);
    let sessionManager: SessionManager;
    if (chat.session_file && existsSync(chat.session_file)) {
      sessionManager = SessionManager.open(chat.session_file, this.sessionDir, this.opts.workspace);
    } else {
      sessionManager = SessionManager.create(this.opts.workspace, this.sessionDir);
      await this.opts.repo.setChatSession(chatId, sessionManager.getSessionFile() ?? null, new Date());
    }
    const session = await this.buildSession(sessionManager, this.modelIdFor(chat.model), `chat:${chatId}`);
    this.sessions.set(chatId, session);
    return session;
  }

  private async buildSession(sessionManager: SessionManager, modelId: string, runKey: string): Promise<AgentSession> {
    const { opts } = this;
    const model = opts.resolveModel(modelId) ?? opts.resolveModel(opts.defaultModel);
    if (!model) throw new Error(`Model ${modelId} is not available`);
    const getRun = () => this.runs.get(runKey);
    const toolDeps = {
      sandbox: opts.sandbox,
      rules: opts.rules,
      approvals: opts.approvals,
      repo: opts.repo,
      log: opts.log,
      workspace: opts.workspace,
      toolTimeoutSeconds: opts.toolTimeoutSeconds,
      maxOutputChars: opts.maxOutputChars,
      redact: opts.redact,
      getRun,
    };
    const agentTools = [...createSandboxBackedTools(toolDeps), ...(opts.toolFactories ?? []).flatMap((f) => f(getRun))];
    const customTools = guardTools(agentTools, toolDeps);

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: opts.workspace,
      agentDir: path.join(opts.dataDir, "pi"),
      modelRuntime: opts.modelRuntime,
      model,
      thinkingLevel: "low",
      resourceLoader: isolatedResourceLoader(opts.systemPrompt, () => this.addendum),
      tools: customTools.map((t) => t.name),
      customTools,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        // Transient provider errors (rate limits, 5xx, timeouts) retry with exponential backoff.
        retry: { enabled: true, maxRetries: opts.modelMaxRetries ?? 4, baseDelayMs: 2000 },
      }),
    });
    if (modelFallbackMessage) opts.log.warn({ runKey, modelFallbackMessage }, "session model fallback");
    return session;
  }

  /** Run one prompt to completion. Never throws for model or tool errors; reports them in the result. */
  async run(input: RunInput): Promise<RunResult> {
    const { opts } = this;
    const runKey = input.session === "chat" ? `chat:${input.chatId}` : `routine:${input.taskId}`;
    if (opts.getPromptAddendum) this.addendum = await opts.getPromptAddendum();

    let session: AgentSession;
    if (input.session === "chat") {
      session = await this.getChatSession(input.chatId);
    } else {
      const chat = await opts.repo.ensureChat(input.chatId);
      session = await this.buildSession(SessionManager.create(opts.workspace, this.routineDir), this.modelIdFor(chat.model), runKey);
    }
    // Re-read the system prompt so the latest profile is in it (Pi diffs and persists the change).
    session.setActiveToolsByName(session.getActiveToolNames());

    const run: RunContext = {
      taskId: input.taskId,
      chatId: input.chatId,
      trigger: input.trigger,
      tainted: false,
      signal: input.signal,
      approvalTimeoutSeconds: input.approvalTimeoutSeconds,
      lastAssistantText: "",
      onToolStart: input.hooks.onToolStart,
      onWaitingApproval: input.hooks.onWaitingApproval,
      sendImage: input.hooks.sendImage,
    };
    this.runs.set(runKey, run);
    let lastAssistant: AssistantMessage | undefined;
    let turns = 0;
    let limitMessage: string | undefined;
    const stopForLimit = (message: string) => {
      if (limitMessage) return;
      limitMessage = message;
      void session.abort().catch(() => undefined);
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start") {
        turns++;
        if (turns > input.maxTurns) {
          stopForLimit(`Stopped after ${input.maxTurns} steps (MAX_TURNS_PER_TASK) so it can't loop forever.`);
          return;
        }
        // Budget check before each model call.
        void input.hooks.beforeModelCall?.().then((reason) => {
          if (reason) stopForLimit(reason);
        });
        return;
      }
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message as AssistantMessage;
      lastAssistant = message;
      run.lastAssistantText = assistantText(message);
      const u = message.usage;
      if (u && (u.input > 0 || u.output > 0)) {
        opts.repo
          .insertUsage({
            taskId: input.taskId,
            model: `${message.provider}/${message.model}`,
            inputTokens: u.input,
            outputTokens: u.output,
            cacheReadTokens: u.cacheRead,
            costUsd: u.cost?.total ?? 0,
          })
          .catch((err: unknown) => opts.log.error({ err }, "could not record usage"));
      }
    });
    const onAbort = () => void session.abort().catch(() => undefined);
    input.signal.addEventListener("abort", onAbort, { once: true });

    const stopped = (): RunResult | undefined => {
      if (limitMessage) return { text: "", aborted: true, stopReason: "limit", stopMessage: limitMessage };
      if (input.signal.aborted) return { text: "", aborted: true, stopReason: "user" };
      return undefined;
    };

    try {
      const before = await input.hooks.beforeModelCall?.();
      if (before) return { text: "", aborted: true, stopReason: "limit", stopMessage: before };
      if (input.signal.aborted) return { text: "", aborted: true, stopReason: "user" };
      await session.prompt(input.prompt);
      const s = stopped();
      if (s) return s;
      if (lastAssistant?.stopReason === "aborted") return { text: "", aborted: true, stopReason: "user" };
      if (lastAssistant?.stopReason === "error") {
        return { text: session.getLastAssistantText() ?? "", aborted: false, error: lastAssistant.errorMessage ?? "model error" };
      }
      return { text: session.getLastAssistantText() ?? "", aborted: false };
    } catch (err) {
      return stopped() ?? { text: "", aborted: false, error: (err as Error).message };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      this.runs.delete(runKey);
      if (input.session === "chat") {
        const file = session.sessionFile;
        if (file) {
          const chat = await opts.repo.getChat(input.chatId);
          if (chat?.session_file !== file) await opts.repo.setChatSession(input.chatId, file, chat?.session_started_at ?? new Date());
        }
      } else {
        session.dispose();
      }
    }
  }

  isRunning(chatId: number): boolean {
    return this.runs.has(`chat:${chatId}`);
  }

  /** Archive the chat's session file and start fresh on the next message. */
  async newSession(chatId: number): Promise<void> {
    if (this.isRunning(chatId)) throw new Error("A task is running; /stop it first.");
    const session = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    session?.dispose();
    const chat = await this.opts.repo.getChat(chatId);
    if (chat?.session_file && existsSync(chat.session_file)) {
      const target = path.join(this.archiveDir, `${Date.now()}-${path.basename(chat.session_file)}`);
      await rename(chat.session_file, target);
    }
    await this.opts.repo.setChatSession(chatId, null, null);
  }

  /** Switch the chat's model now (and for future sessions and routines). */
  async setModel(chatId: number, modelId: string): Promise<void> {
    const model = this.opts.resolveModel(modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    await this.opts.repo.setChatModel(chatId, modelId);
    const session = this.sessions.get(chatId);
    if (session) await session.setModel(model);
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }
}

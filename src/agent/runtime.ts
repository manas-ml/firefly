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
import { createAgentTools, type RunContext } from "./tools.ts";

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
  approvalTimeoutSeconds: number;
  maxOutputChars: number;
  systemPrompt: string;
}

export interface RunHooks {
  onToolStart(description: string): void;
  onWaitingApproval(waiting: boolean): void | Promise<void>;
}

export interface RunResult {
  text: string;
  aborted: boolean;
  error?: string;
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
function isolatedResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
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

/** One Pi session per Telegram chat, persisted as JSONL under DATA_DIR/sessions. */
export class AgentRuntime {
  private readonly sessions = new Map<number, AgentSession>();
  private readonly runs = new Map<number, RunContext>();
  private readonly creating = new Map<number, Promise<AgentSession>>();
  private readonly sessionDir: string;
  private readonly archiveDir: string;

  constructor(private readonly opts: RuntimeOptions) {
    this.sessionDir = path.join(opts.dataDir, "sessions");
    this.archiveDir = path.join(this.sessionDir, "archive");
  }

  async init(): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true });
  }

  modelIdFor(chatModel: string | null | undefined): string {
    return chatModel ?? this.opts.defaultModel;
  }

  hasModel(id: string): boolean {
    return this.opts.resolveModel(id) !== undefined;
  }

  private getSession(chatId: number): Promise<AgentSession> {
    const cached = this.sessions.get(chatId);
    if (cached) return Promise.resolve(cached);
    let pending = this.creating.get(chatId);
    if (!pending) {
      pending = this.createSession(chatId).finally(() => this.creating.delete(chatId));
      this.creating.set(chatId, pending);
    }
    return pending;
  }

  private async createSession(chatId: number): Promise<AgentSession> {
    const { opts } = this;
    const chat = await opts.repo.ensureChat(chatId);
    const modelId = this.modelIdFor(chat.model);
    const model = opts.resolveModel(modelId) ?? opts.resolveModel(opts.defaultModel);
    if (!model) throw new Error(`Model ${modelId} is not available`);

    let sessionManager: SessionManager;
    if (chat.session_file && existsSync(chat.session_file)) {
      sessionManager = SessionManager.open(chat.session_file, this.sessionDir, opts.workspace);
    } else {
      sessionManager = SessionManager.create(opts.workspace, this.sessionDir);
      await opts.repo.setChatSession(chatId, sessionManager.getSessionFile() ?? null, new Date());
    }

    const tools = createAgentTools({
      sandbox: opts.sandbox,
      rules: opts.rules,
      approvals: opts.approvals,
      repo: opts.repo,
      log: opts.log,
      workspace: opts.workspace,
      toolTimeoutSeconds: opts.toolTimeoutSeconds,
      approvalTimeoutSeconds: opts.approvalTimeoutSeconds,
      maxOutputChars: opts.maxOutputChars,
      getRun: () => this.runs.get(chatId),
    });

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: opts.workspace,
      agentDir: path.join(opts.dataDir, "pi"),
      modelRuntime: opts.modelRuntime,
      model,
      thinkingLevel: "low",
      resourceLoader: isolatedResourceLoader(opts.systemPrompt),
      tools: ["bash", "read", "write", "edit"],
      customTools: tools,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 3 },
      }),
    });
    if (modelFallbackMessage) opts.log.warn({ chatId, modelFallbackMessage }, "session model fallback");
    this.sessions.set(chatId, session);
    return session;
  }

  /** Run one prompt to completion. Never throws for model or tool errors; reports them in the result. */
  async run(input: { chatId: number; taskId: string; prompt: string; signal: AbortSignal; hooks: RunHooks }): Promise<RunResult> {
    const { opts } = this;
    const session = await this.getSession(input.chatId);
    const run: RunContext = {
      taskId: input.taskId,
      chatId: input.chatId,
      signal: input.signal,
      lastAssistantText: "",
      onToolStart: input.hooks.onToolStart,
      onWaitingApproval: input.hooks.onWaitingApproval,
    };
    this.runs.set(input.chatId, run);
    let lastAssistant: AssistantMessage | undefined;

    const unsubscribe = session.subscribe((event) => {
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

    try {
      if (input.signal.aborted) return { text: "", aborted: true };
      await session.prompt(input.prompt);
      const aborted = input.signal.aborted || lastAssistant?.stopReason === "aborted";
      if (!aborted && lastAssistant?.stopReason === "error") {
        return { text: session.getLastAssistantText() ?? "", aborted: false, error: lastAssistant.errorMessage ?? "model error" };
      }
      return { text: session.getLastAssistantText() ?? "", aborted };
    } catch (err) {
      if (input.signal.aborted) return { text: "", aborted: true };
      return { text: "", aborted: false, error: (err as Error).message };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      this.runs.delete(input.chatId);
      const file = session.sessionFile;
      if (file) {
        const chat = await opts.repo.getChat(input.chatId);
        if (chat?.session_file !== file) await opts.repo.setChatSession(input.chatId, file, chat?.session_started_at ?? new Date());
      }
    }
  }

  isRunning(chatId: number): boolean {
    return this.runs.has(chatId);
  }

  /** Archive the chat's session file and start fresh on the next message. */
  async newSession(chatId: number): Promise<void> {
    if (this.runs.has(chatId)) throw new Error("A task is running; /stop it first.");
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

  /** Switch the chat's model now (and for future sessions). */
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

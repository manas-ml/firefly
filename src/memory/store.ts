import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "../db/pool.ts";

export const PROFILE_TOPIC = "profile";

/** Topics are file names: lowercase words joined by dashes. */
export function normalizeTopic(input: string | undefined): string {
  const t = (input ?? PROFILE_TOPIC)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return t || PROFILE_TOPIC;
}

export interface MemoryHit {
  topic: string;
  content: string;
  created_at: Date;
}

/**
 * Memory as Markdown files (one per topic, `profile.md` for facts about the
 * owner) in the memory volume, plus a `memories` table indexing each fact for
 * search. The files are what the owner reads and backs up; the table is an index.
 */
export class MemoryStore {
  constructor(
    private readonly dir: string,
    private readonly pool: Pool,
    /** Rough cap on profile size in the system prompt (~4 characters per token). */
    private readonly profileMaxChars = 8000,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private file(topic: string): string {
    return path.join(this.dir, `${normalizeTopic(topic)}.md`);
  }

  async add(topicInput: string | undefined, fact: string, sourceTaskId: string | null): Promise<{ topic: string; duplicate: boolean }> {
    const topic = normalizeTopic(topicInput);
    const clean = fact.replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("Nothing to remember.");
    if (clean.length > 1000) throw new Error("That is too long to remember as one fact (1000 characters max).");
    const existing = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memories WHERE topic = $1 AND lower(content) = lower($2)",
      [topic, clean],
    );
    if ((existing.rows[0]?.n ?? 0) > 0) return { topic, duplicate: true };
    await this.pool.query("INSERT INTO memories (topic, content, source_task_id) VALUES ($1, $2, $3)", [topic, clean, sourceTaskId]);
    await this.writeTopicFile(topic);
    return { topic, duplicate: false };
  }

  /** Rewrite a topic's Markdown file from the index. */
  private async writeTopicFile(topic: string): Promise<void> {
    const rows = await this.pool.query<{ content: string }>(
      "SELECT content FROM memories WHERE topic = $1 ORDER BY created_at",
      [topic],
    );
    if (rows.rows.length === 0) {
      await rm(this.file(topic), { force: true });
      return;
    }
    const title = topic === PROFILE_TOPIC ? "Profile" : topic.replace(/-/g, " ");
    const body = `# ${title}\n\n${rows.rows.map((r) => `- ${r.content}`).join("\n")}\n`;
    await writeFile(this.file(topic), body, "utf8");
  }

  async readTopic(topic: string): Promise<string | undefined> {
    try {
      return await readFile(this.file(topic), "utf8");
    } catch {
      return undefined;
    }
  }

  /** profile.md for the system prompt, capped; the newest facts are kept if it's too long. */
  async profileForPrompt(): Promise<string> {
    const text = (await this.readTopic(PROFILE_TOPIC)) ?? "";
    if (text.length <= this.profileMaxChars) return text.trim();
    const lines = text.split("\n");
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (size + line.length + 1 > this.profileMaxChars - 40) break;
      kept.unshift(line);
      size += line.length + 1;
    }
    return `# Profile (older entries omitted)\n${kept.join("\n")}`.trim();
  }

  async listTopics(): Promise<{ topic: string; count: number }[]> {
    const r = await this.pool.query<{ topic: string; count: number }>(
      "SELECT topic, count(*)::int AS count FROM memories GROUP BY topic ORDER BY topic = 'profile' DESC, topic",
    );
    return r.rows;
  }

  async search(query: string, limit = 20): Promise<MemoryHit[]> {
    const q = query.trim();
    if (!q) return [];
    const r = await this.pool.query<MemoryHit>(
      `SELECT topic, content, created_at FROM memories
       WHERE search @@ plainto_tsquery('simple', $1) OR content ILIKE '%' || $1 || '%' OR topic ILIKE '%' || $1 || '%'
       ORDER BY ts_rank(search, plainto_tsquery('simple', $1)) DESC, created_at DESC
       LIMIT $2`,
      [q, limit],
    );
    return r.rows;
  }

  async forget(topicInput: string): Promise<number> {
    const topic = normalizeTopic(topicInput);
    const r = await this.pool.query("DELETE FROM memories WHERE topic = $1", [topic]);
    await rm(this.file(topic), { force: true });
    return r.rowCount ?? 0;
  }

  /** Re-index from files (after restoring a backup of the memory volume only). */
  async topicsOnDisk(): Promise<string[]> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  }
}

import Fastify, { type FastifyInstance } from "fastify";

export interface HealthChecks {
  db(): Promise<boolean>;
  sandbox(): Promise<boolean>;
  telegram(): boolean;
}

/**
 * Health endpoint only. The sandbox can reach this port over the internal
 * network, so it must never expose anything sensitive.
 */
export function createHttpServer(checks: HealthChecks): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/health", async (_req, reply) => {
    const [db, sandbox] = await Promise.all([checks.db().catch(() => false), checks.sandbox().catch(() => false)]);
    const telegram = checks.telegram();
    const ok = db && sandbox && telegram;
    return reply.code(ok ? 200 : 503).send({ ok, db, sandbox, telegram });
  });
  return app;
}

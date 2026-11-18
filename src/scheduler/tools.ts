import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentTool, type AgentTool, type RunContext } from "../agent/tools.ts";
import { describeCron, validateCron } from "./cron.ts";
import { describeSchedule, type SchedulerService } from "./service.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

export function createScheduleTools(scheduler: SchedulerService, getRun: () => RunContext | undefined): AgentTool[] {
  const tz = scheduler.defaultTimezone;
  const requireRun = () => {
    const run = getRun();
    if (!run) throw new Error("No active task");
    return run;
  };

  const create = defineTool({
    name: "create_schedule",
    label: "Create routine",
    description: `Create (or replace, by name) a routine: a prompt you will run on a cron schedule, in a fresh session, with results sent to the owner. Times are in ${tz} unless a timezone is given. Write the prompt as a complete instruction to your future self; mention that if there is nothing worth reporting you should reply exactly NO_REPORT. The owner must approve.`,
    promptSnippet: "Create a scheduled routine (needs approval)",
    parameters: Type.Object({
      name: Type.String({ description: "Short unique name, e.g. 'morning-summary'" }),
      cron: Type.String({ description: "5-field cron: minute hour day-of-month month day-of-week, e.g. '0 8 * * 1-5' for weekdays at 8:00" }),
      prompt: Type.String({ description: "What to do each time it runs" }),
      timezone: Type.Optional(Type.String({ description: `IANA time zone, default ${tz}` })),
    }),
    async execute(_id, params) {
      const run = requireRun();
      const row = await scheduler.create({ chatId: run.chatId, name: params.name, cron: params.cron, timezone: params.timezone, prompt: params.prompt });
      return text(`Created routine "${row.name}": ${describeSchedule(row)}. Next run: ${row.next_run_at?.toISOString() ?? "unknown"}.`);
    },
  });

  const list = defineTool({
    name: "list_schedules",
    label: "List routines",
    description: "List the owner's routines with their schedule, whether they're on, and when they run next.",
    promptSnippet: "List routines",
    parameters: Type.Object({}),
    async execute() {
      const run = requireRun();
      const rows = await scheduler.list(run.chatId);
      if (rows.length === 0) return text("No routines.");
      return text(
        rows
          .map((r) => `- ${r.name} [${r.enabled ? "on" : "off"}]: ${describeSchedule(r)}; next ${r.next_run_at?.toISOString() ?? "-"}\n  ${r.prompt}`)
          .join("\n"),
      );
    },
  });

  const del = defineTool({
    name: "delete_schedule",
    label: "Delete routine",
    description: "Delete a routine by name. The owner must approve.",
    promptSnippet: "Delete a routine (needs approval)",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      const run = requireRun();
      const row = await scheduler.findByName(run.chatId, params.name);
      if (!row) throw new Error(`No routine named "${params.name}".`);
      await scheduler.delete(row.id);
      return text(`Deleted routine "${row.name}".`);
    },
  });

  return [
    agentTool(create, {
      taints: false,
      ownerData: true,
      // The approval message shows the schedule in plain words.
      describe: (a) =>
        [
          `Create routine “${String(a.name)}”`,
          `When: ${describeCron(String(a.cron))} (${typeof a.timezone === "string" && a.timezone ? a.timezone : tz})`,
          `Cron: ${String(a.cron)}`,
          `Task: ${String(a.prompt)}`,
        ].join("\n"),
      preflight: async (a) => {
        const invalid = validateCron(String(a.cron ?? ""), typeof a.timezone === "string" && a.timezone ? a.timezone : tz);
        return invalid ? { invalid } : {};
      },
    }),
    agentTool(list, { taints: false, ownerData: true }),
    agentTool(del, { taints: false, ownerData: true, describe: (a) => `Delete routine “${String(a.name)}”` }),
  ];
}

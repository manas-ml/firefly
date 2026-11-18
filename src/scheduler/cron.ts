import cronstrue from "cronstrue";
import { CronExpressionParser } from "cron-parser";

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Returns an error message, or undefined if the cron expression and time zone are valid. */
export function validateCron(cron: string, tz: string): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return "cron must have 5 fields: minute hour day-of-month month day-of-week";
  if (!isValidTimezone(tz)) return `unknown time zone ${tz}`;
  try {
    CronExpressionParser.parse(cron, { tz });
  } catch (err) {
    return `invalid cron: ${(err as Error).message}`;
  }
  return undefined;
}

/** "0 8 * * 1-5" -> "At 08:00, Monday through Friday". */
export function describeCron(cron: string): string {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true, verbose: false });
  } catch {
    return cron;
  }
}

export function nextRun(cron: string, tz: string, from = new Date()): Date | undefined {
  try {
    return CronExpressionParser.parse(cron, { tz, currentDate: from }).next().toDate();
  } catch {
    return undefined;
  }
}

import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

let redactor: ((text: string) => string) | undefined;

/** Install a function that strips vault secret values from every log line. */
export function setLogRedactor(fn: (text: string) => string): void {
  redactor = fn;
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      hooks: {
        streamWrite: (line) => (redactor ? redactor(line) : line),
      },
      base: { service: "agent" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ["token", "apiKey", "*.token", "*.apiKey", "headers.authorization", "*.headers.authorization"],
        censor: "[redacted]",
      },
    },
    destination,
  );
}

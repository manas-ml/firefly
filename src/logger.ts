import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
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

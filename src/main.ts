import { startApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
process.env.TZ = config.TZ;
const log = createLogger(config.LOG_LEVEL);

try {
  const app = await startApp(config, log);
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      const force = setTimeout(() => process.exit(1), 20_000);
      force.unref();
      void app.stop().then(() => process.exit(0));
    });
  }
} catch (err) {
  log.fatal({ err }, "startup failed");
  process.exit(1);
}

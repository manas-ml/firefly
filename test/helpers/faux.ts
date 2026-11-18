import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** A ModelRuntime with a scripted provider standing in for OpenRouter. */
export async function createFauxRuntime() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-"));
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json") });
  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "deepseek/deepseek-v4.1-flash", cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 } },
      { id: "other/model", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    ],
    tokensPerSecond: 100000,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  return { modelRuntime, faux, resolveModel: (id: string) => faux.getModel(id) };
}

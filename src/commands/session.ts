import { assertProviderServes } from "../catalog.js";
import { bindingFor, loadConfig, type ModelBinding } from "../config.js";
import type { RunCtx } from "../runs.js";

export async function adoptBinding(
  ctx: RunCtx,
  project: string,
  env: NodeJS.ProcessEnv,
  modelId: string,
): Promise<{ binding: ModelBinding; config: Awaited<ReturnType<typeof loadConfig>>["config"] }> {
  const loaded = await loadConfig(project, env);
  const binding = loaded.config.models[modelId] ?? null;
  ctx.binding = binding;
  const source = loaded.sources[modelId];
  if (source !== undefined) ctx.source = source;
  if (binding === null) {
    return { binding: bindingFor(loaded.config, modelId), config: loaded.config };
  }
  assertProviderServes(binding.provider, modelId);
  const value = env[binding.apiKeyEnv];
  ctx.keyPresent = typeof value === "string" && value.trim().length > 0;
  if (ctx.keyPresent && value !== undefined) ctx.secret = value;
  return { binding, config: loaded.config };
}

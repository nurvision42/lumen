import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertProviderServes, BREAKDOWN_LEVEL, BREAKDOWN_NEED_AUDIO, BREAKDOWN_PREFER_MODELS } from "./catalog.js";
import { CliError } from "./errors.js";
import { fileExists } from "./fsutil.js";

export const bindingSchema = z
  .object({
    provider: z.string().min(1),
    baseUrl: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    group: z.string().min(1).optional(),
    modelAlias: z.string().min(1).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    models: z.record(z.string(), bindingSchema).optional(),
    breakdown: z
      .object({
        prompt: z.string().optional(),
        promptFile: z.string().optional(),
        preferModels: z.array(z.string().trim().min(1)).min(1).optional(),
        level: z.string().trim().min(1).optional(),
        needAudio: z.boolean().optional(),
      })
      .strict()
      .optional(),
    tools: z
      .object({
        ffmpeg: z.string().min(1).optional(),
        ffprobe: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelBinding = z.infer<typeof bindingSchema>;

export interface ToolPaths {
  ffmpeg?: string;
  ffprobe?: string;
}

export interface LumenConfig {
  models: Record<string, ModelBinding>;
  breakdown: {
    prompt?: string;
    promptFile?: string;
    preferModels?: readonly string[];
    level?: string;
    needAudio?: boolean;
  };
  tools: ToolPaths;
}

export const EMPTY_CONFIG: LumenConfig = { models: {}, breakdown: {}, tools: {} };

export function projectConfigPath(project: string): string {
  return path.join(project, "lumen.config.json");
}

export function globalConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.XDG_CONFIG_HOME ?? (env.HOME ? path.join(env.HOME, ".config") : undefined);
  if (base === undefined || base.length === 0) return undefined;
  return path.join(base, "lumen", "providers.json");
}

export function parseConfig(raw: unknown, label: string): LumenConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new CliError(`${label}: ${detail}`);
  }
  return {
    models: parsed.data.models ?? {},
    breakdown: parsed.data.breakdown ?? {},
    tools: parsed.data.tools ?? {},
  };
}

export async function readConfigFile(file: string): Promise<LumenConfig> {
  if (!(await fileExists(file))) return { models: {}, breakdown: {}, tools: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new CliError(`${file}: not valid JSON`);
  }
  return parseConfig(raw, file);
}

export async function writeConfigFile(file: string, config: LumenConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tools = {
    ...(config.tools.ffmpeg === undefined ? {} : { ffmpeg: config.tools.ffmpeg }),
    ...(config.tools.ffprobe === undefined ? {} : { ffprobe: config.tools.ffprobe }),
  };
  const body = {
    models: config.models,
    breakdown: config.breakdown,
    ...(Object.keys(tools).length === 0 ? {} : { tools }),
  };
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
}

export interface LoadedConfig {
  config: LumenConfig;
  /** Which file supplied each model binding. Project wins over global. */
  sources: Record<string, "project" | "global">;
}

export async function loadConfig(project: string, env: NodeJS.ProcessEnv): Promise<LoadedConfig> {
  const globalPath = globalConfigPath(env);
  const global = globalPath === undefined ? EMPTY_CONFIG : await readConfigFile(globalPath);
  const local = await readConfigFile(projectConfigPath(project));
  const models: Record<string, ModelBinding> = { ...global.models, ...local.models };
  const sources: Record<string, "project" | "global"> = {};
  for (const id of Object.keys(models)) {
    sources[id] = id in local.models ? "project" : "global";
  }
  return {
    config: {
      models,
      breakdown: mergeBreakdown(global.breakdown, local.breakdown),
      tools: mergeTools(global.tools, local.tools),
    },
    sources,
  };
}

function listedModels(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const models = value.map((id) => id.trim()).filter((id) => id.length > 0);
  return models.length > 0 ? models : undefined;
}

/** Project list replaces the global list. An omitted list is the lite default. */
export function breakdownPreferModels(breakdown: LumenConfig["breakdown"]): readonly string[] {
  return listedModels(breakdown.preferModels) ?? [...BREAKDOWN_PREFER_MODELS];
}

/** Project level replaces the global level. An omitted level is Quality. */
export function breakdownLevel(breakdown: LumenConfig["breakdown"]): string {
  return breakdown.level?.trim() || BREAKDOWN_LEVEL;
}

/** Project needAudio replaces the global value. Omitted means audio is requested. */
export function breakdownNeedAudio(breakdown: LumenConfig["breakdown"]): boolean {
  return breakdown.needAudio ?? BREAKDOWN_NEED_AUDIO;
}

/** A project path replaces that tool only. The other tool can still come from the global file. */
function mergeTools(global: ToolPaths, local: ToolPaths): ToolPaths {
  return {
    ...(global.ffmpeg === undefined ? {} : { ffmpeg: global.ffmpeg }),
    ...(global.ffprobe === undefined ? {} : { ffprobe: global.ffprobe }),
    ...(local.ffmpeg === undefined ? {} : { ffmpeg: local.ffmpeg }),
    ...(local.ffprobe === undefined ? {} : { ffprobe: local.ffprobe }),
  };
}

/** An empty project prompt does not hide a global one. Init writes `"prompt": ""`. */
function mergeBreakdown(
  global: LumenConfig["breakdown"],
  local: LumenConfig["breakdown"],
): LumenConfig["breakdown"] {
  const prompt = local.prompt?.trim() ? local.prompt : global.prompt?.trim() ? global.prompt : undefined;
  const promptFile = local.promptFile?.trim() ? local.promptFile : global.promptFile?.trim() ? global.promptFile : undefined;
  const preferModels = listedModels(local.preferModels) ?? listedModels(global.preferModels);
  const level = local.level?.trim() || global.level?.trim() || undefined;
  const needAudio = local.needAudio ?? global.needAudio;
  return {
    ...(prompt === undefined ? {} : { prompt }),
    ...(promptFile === undefined ? {} : { promptFile }),
    ...(preferModels === undefined ? {} : { preferModels }),
    ...(level === undefined ? {} : { level }),
    ...(needAudio === undefined ? {} : { needAudio }),
  };
}

export function bindingFor(config: LumenConfig, modelId: string): ModelBinding {
  const binding = config.models[modelId];
  if (binding === undefined) {
    throw new CliError(
      `no provider binding for ${modelId}\nset one with: lumen providers set ${modelId} --provider <id> --base-url <url> --api-key-env <NAME>`,
    );
  }
  return binding;
}

export function assertBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("baseUrl must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError("baseUrl must be an http(s) URL");
  return value.replace(/\/$/, "");
}

export interface ReadyBinding {
  config: LumenConfig;
  binding: ModelBinding | null;
  source?: "project" | "global";
  keyPresent: boolean;
  /** Present only in memory. Never written to a run record. */
  secret?: string;
}

export async function readyBinding(project: string, env: NodeJS.ProcessEnv, modelId: string): Promise<ReadyBinding> {
  const loaded = await loadConfig(project, env);
  const binding = loaded.config.models[modelId];
  if (binding === undefined) {
    return { config: loaded.config, binding: null, keyPresent: false };
  }
  assertProviderServes(binding.provider, modelId);
  const value = env[binding.apiKeyEnv];
  const keyPresent = typeof value === "string" && value.trim().length > 0;
  return {
    config: loaded.config,
    binding,
    source: loaded.sources[modelId],
    keyPresent,
    ...(keyPresent ? { secret: value } : {}),
  };
}

export function missingKey(binding: ModelBinding): CliError {
  return new CliError(`missing API key env ${binding.apiKeyEnv}\nlumen doctor`);
}

export const CONFIG_TEMPLATE = `{
  "models": {},
  "breakdown": {
    "prompt": ""
  }
}
`;

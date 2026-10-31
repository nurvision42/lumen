import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertProviderServes, PROVIDER_DEFAULT_BASE_URLS, BREAKDOWN_LEVEL, BREAKDOWN_NEED_AUDIO, BREAKDOWN_PREFER_MODELS } from "./catalog.js";
import { CliError } from "./errors.js";
import { fileExists } from "./fsutil.js";

export const bindingSchema = z
  .object({
    provider: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    group: z.string().min(1).optional(),
    modelAlias: z.string().min(1).optional(),
  })
  .strict();

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** Partial TOS block as written in a config file. Omitted fields use TOS_DEFAULTS. */
export const tosSettingsSchema = z
  .object({
    bucket: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    accessKeyEnv: envName.optional(),
    secretKeyEnv: envName.optional(),
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
    tos: tosSettingsSchema.optional(),
  })
  .strict();

/** A binding as written in a config file; baseUrl may be omitted to use the provider default. */
export type StoredBinding = z.infer<typeof bindingSchema>;
/** A binding with baseUrl resolved (user value, else the provider's built-in default). */
export type ModelBinding = StoredBinding & { baseUrl: string; baseUrlDefault?: boolean };

/** TOS settings exactly as stored. An empty object still means TOS is configured. */
export type TosSettings = z.infer<typeof tosSettingsSchema>;

/** TOS settings with defaults filled in. Present on LumenConfig only when a tos block exists. */
export interface TosConfig {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyEnv: string;
  secretKeyEnv: string;
}

/** Defaults for the existing private bucket. Credentials stay in the named env vars. */
export const TOS_DEFAULTS: TosConfig = {
  bucket: "lumen42",
  region: "cn-beijing",
  endpoint: "tos-cn-beijing.volces.com",
  accessKeyEnv: "VOLC_ACCESSKEY",
  secretKeyEnv: "VOLC_SECRETKEY",
};

/** Strip a scheme or path so the endpoint is a host the bucket can be prefixed onto. */
export function normalizeTosEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  const noScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return (noScheme.split("/")[0] ?? "").trim();
}

export function resolveTos(settings: TosSettings): TosConfig {
  const endpoint = normalizeTosEndpoint(settings.endpoint ?? TOS_DEFAULTS.endpoint);
  const bucket = (settings.bucket ?? TOS_DEFAULTS.bucket).trim();
  const region = (settings.region ?? TOS_DEFAULTS.region).trim();
  if (bucket.length === 0) throw new CliError("tos.bucket is empty");
  if (region.length === 0) throw new CliError("tos.region is empty");
  if (endpoint.length === 0) throw new CliError("tos.endpoint is empty");
  return {
    bucket,
    region,
    endpoint,
    accessKeyEnv: settings.accessKeyEnv ?? TOS_DEFAULTS.accessKeyEnv,
    secretKeyEnv: settings.secretKeyEnv ?? TOS_DEFAULTS.secretKeyEnv,
  };
}

export interface StoredConfig extends Omit<LumenConfig, "models" | "tos"> {
  models: Record<string, StoredBinding>;
  tos?: TosSettings;
}

/** Fill in the provider's default baseUrl when the binding does not set one. */
export function resolveBinding(binding: StoredBinding): ModelBinding {
  if (binding.baseUrl !== undefined) return { ...binding, baseUrl: binding.baseUrl };
  const fallback = (PROVIDER_DEFAULT_BASE_URLS as Record<string, string | undefined>)[binding.provider];
  if (fallback === undefined) {
    throw new CliError(`provider ${binding.provider} has no default baseUrl; set one with --base-url`);
  }
  return { ...binding, baseUrl: fallback, baseUrlDefault: true };
}

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
  /** Set only when a config file contains a tos block. Absent means TOS is not configured. */
  tos?: TosConfig;
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

export function parseConfig(raw: unknown, label: string): StoredConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new CliError(`${label}: ${detail}`);
  }
  return {
    models: parsed.data.models ?? {},
    breakdown: parsed.data.breakdown ?? {},
    tools: parsed.data.tools ?? {},
    ...(parsed.data.tos === undefined ? {} : { tos: parsed.data.tos }),
  };
}

export async function readConfigFile(file: string): Promise<StoredConfig> {
  if (!(await fileExists(file))) return { models: {}, breakdown: {}, tools: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new CliError(`${file}: not valid JSON`);
  }
  return parseConfig(raw, file);
}

export async function writeConfigFile(file: string, config: StoredConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tools = {
    ...(config.tools.ffmpeg === undefined ? {} : { ffmpeg: config.tools.ffmpeg }),
    ...(config.tools.ffprobe === undefined ? {} : { ffprobe: config.tools.ffprobe }),
  };
  const body = {
    models: config.models,
    breakdown: config.breakdown,
    ...(Object.keys(tools).length === 0 ? {} : { tools }),
    ...(config.tos === undefined ? {} : { tos: config.tos }),
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
  const global: StoredConfig = globalPath === undefined ? EMPTY_CONFIG : await readConfigFile(globalPath);
  const local = await readConfigFile(projectConfigPath(project));
  const stored: Record<string, StoredBinding> = { ...global.models, ...local.models };
  const models: Record<string, ModelBinding> = {};
  for (const [id, binding] of Object.entries(stored)) models[id] = resolveBinding(binding);
  const sources: Record<string, "project" | "global"> = {};
  for (const id of Object.keys(models)) {
    sources[id] = id in local.models ? "project" : "global";
  }
  const tos = mergeTos(global.tos, local.tos);
  return {
    config: {
      models,
      breakdown: mergeBreakdown(global.breakdown, local.breakdown),
      tools: mergeTools(global.tools, local.tools),
      ...(tos === undefined ? {} : { tos }),
    },
    sources,
  };
}

/** A tos block in either file enables TOS. Project fields replace the same global fields. */
function mergeTos(global: TosSettings | undefined, local: TosSettings | undefined): TosConfig | undefined {
  if (global === undefined && local === undefined) return undefined;
  return resolveTos({ ...global, ...local });
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
      `no provider binding for ${modelId}\nset one with: lumen providers set ${modelId} --provider <id> --api-key-env <NAME> [--base-url <url>]`,
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

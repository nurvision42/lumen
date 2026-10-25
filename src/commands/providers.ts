import { assertProviderServes, canonicalModel, modelInfo, PROVIDERS } from "../catalog.js";
import {
  assertBaseUrl,
  globalConfigPath,
  loadConfig,
  projectConfigPath,
  readConfigFile,
  writeConfigFile,
  resolveBinding,
  type StoredBinding,
} from "../config.js";
import { CliError } from "../errors.js";
import { flagString, parseFlags, requireRestEmpty } from "../flags.js";
import { line, type IO } from "../io.js";
import { assertProject } from "../project.js";
import { doctorCommand } from "./doctor.js";

export async function providersCommand(args: string[], project: string, io: IO): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "list") return listProviders(rest, project, io);
  if (sub === "doctor") return doctorCommand(rest, project, io);
  if (sub === "set") return setProvider(rest, project, io);
  throw new CliError("providers needs list, set, or doctor", 2);
}

async function listProviders(args: string[], project: string, io: IO): Promise<number> {
  const { rest } = parseFlags(args, {});
  requireRestEmpty(rest);
  const loaded = await loadConfig(project, io.env);
  const ids = Object.keys(loaded.config.models).sort();
  if (ids.length === 0) {
    line(io, "no model bindings");
  }
  for (const id of ids) {
    const binding = loaded.config.models[id];
    if (binding === undefined) continue;
    const group = binding.group === undefined ? "" : ` group=${binding.group}`;
    const alias = binding.modelAlias === undefined ? "" : ` alias=${binding.modelAlias}`;
    line(io, `${id}  ${binding.provider}  ${binding.baseUrl}${binding.baseUrlDefault ? " (default)" : ""}  ${binding.apiKeyEnv}${group}${alias}  [${loaded.sources[id]}]`);
  }
  line(io, `project: ${projectConfigPath(project)}`);
  const global = globalConfigPath(io.env);
  if (global !== undefined) line(io, `global: ${global}`);
  return 0;
}

async function setProvider(args: string[], project: string, io: IO): Promise<number> {
  const requested = args[0];
  if (requested === undefined || requested.startsWith("-")) throw new CliError("providers set needs a model id", 2);
  const modelId = canonicalModel(requested);
  if (modelInfo(modelId) === undefined) throw new CliError(`unknown model ${requested}`);
  const { values, rest } = parseFlags(args.slice(1), {
    provider: "string",
    "base-url": "string",
    "api-key-env": "string",
    group: "string",
    "model-alias": "string",
    global: "boolean",
  });
  requireRestEmpty(rest);
  const provider = flagString(values, "provider");
  const baseUrl = flagString(values, "base-url");
  const apiKeyEnv = flagString(values, "api-key-env");
  if (provider === undefined || apiKeyEnv === undefined) {
    throw new CliError("providers set needs --provider and --api-key-env (--base-url is optional)", 2);
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new CliError(`unknown provider ${provider}. Known providers: ${PROVIDERS.join(", ")}`);
  }
  assertProviderServes(provider, modelId);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new CliError("apiKeyEnv must match /^[A-Za-z_][A-Za-z0-9_]*$/");
  }
  const stored: StoredBinding = {
    provider,
    ...(baseUrl === undefined ? {} : { baseUrl: assertBaseUrl(baseUrl) }),
    apiKeyEnv,
    ...(flagString(values, "group") === undefined ? {} : { group: flagString(values, "group") }),
    ...(flagString(values, "model-alias") === undefined ? {} : { modelAlias: flagString(values, "model-alias") }),
  };
  const global = values.global === true;
  const file = global ? globalConfigPath(io.env) : projectConfigPath(project);
  if (file === undefined) throw new CliError("no global config path; set HOME or XDG_CONFIG_HOME");
  if (!global) await assertProject(project);
  const current = await readConfigFile(file);
  current.models[modelId] = stored;
  const binding = resolveBinding(stored);
  await writeConfigFile(file, current);
  line(io, `set ${modelId} ${provider} ${binding.baseUrl}${binding.baseUrlDefault ? " (default)" : ""} ${apiKeyEnv} (${global ? "global" : "project"})`);
  return 0;
}

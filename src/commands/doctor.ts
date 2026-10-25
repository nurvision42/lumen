import { fileURLToPath } from "node:url";
import { MODELS } from "../catalog.js";
import { isDeferredPrompt } from "../catalog.js";
import { breakdownLevel, breakdownNeedAudio, breakdownPreferModels, globalConfigPath, loadConfig, projectConfigPath } from "../config.js";
import { tikhubKeyPresent } from "../credentials.js";
import { rejectUnknown } from "../args.js";
import { envPresence } from "../fsutil.js";
import { installReport, packageRootFrom } from "../install/locate.js";
import { line, type IO } from "../io.js";
import { skillReport } from "../skill/place.js";
import { binaryLine, configuredBinary, resolveBinary, resolveSharp, sharpLine } from "../tools/resolve.js";
import { readVersion } from "../version.js";

/** Reports ffmpeg, each model binding, and whether a breakdown prompt is configured. No network. */
export async function doctorCommand(args: string[], project: string, io: IO): Promise<number> {
  rejectUnknown(args);
  const loaded = await loadConfig(project, io.env);
  line(io, "lumen doctor");
  line(io, "presence only, no network");
  line(io, "");
  for (const row of await installReport(io.env, packageRootFrom(fileURLToPath(import.meta.url)))) line(io, row);
  for (const row of await skillReport(io.env, readVersion(), io.cwd)) line(io, row);
  line(io, "");
  const ffmpeg = await resolveBinary({
    name: "ffmpeg",
    env: io.env,
    configured: configuredBinary("ffmpeg", io.env, loaded.config.tools),
    download: false,
  });
  const ffprobe = await resolveBinary({
    name: "ffprobe",
    env: io.env,
    configured: configuredBinary("ffprobe", io.env, loaded.config.tools),
    download: false,
  });
  const sharp = await resolveSharp({ env: io.env, project, cwd: io.cwd, download: false });
  line(io, binaryLine("ffmpeg", ffmpeg));
  line(io, binaryLine("ffprobe", ffprobe));
  line(io, sharpLine(sharp));
  line(io, "");
  line(io, "models:");
  for (const model of MODELS) {
    const binding = loaded.config.models[model.id];
    if (binding === undefined) {
      line(io, `  ${model.id}: unbound`);
      continue;
    }
    const accepted = (model.providers as readonly string[]).includes(binding.provider);
    const key = envPresence(io.env, binding.apiKeyEnv);
    const group = binding.group === undefined ? "" : ` group=${binding.group}`;
    const alias = binding.modelAlias === undefined ? "" : ` alias=${binding.modelAlias}`;
    const source = loaded.sources[model.id] ?? "project";
    const name = accepted ? binding.provider : `${binding.provider} wrong-provider`;
    line(io, `  ${model.id}: ${name} ${binding.baseUrl}${binding.baseUrlDefault ? " (default)" : ""}${group}${alias} ${binding.apiKeyEnv} ${key} [${source}]`);
    if (!accepted) line(io, `    accepts: ${model.providers.join(", ")}`);
  }
  line(io, "");
  const file = loaded.config.breakdown.promptFile?.trim();
  const promptSet = (file !== undefined && file.length > 0) || !isDeferredPrompt(loaded.config.breakdown.prompt ?? "");
  line(io, `breakdown prompt: ${promptSet ? "set" : "default"}`);
  line(io, `breakdown models: ${breakdownPreferModels(loaded.config.breakdown).join(", ")}`);
  line(io, `breakdown level: ${breakdownLevel(loaded.config.breakdown)}`);
  line(io, `breakdown needAudio: ${breakdownNeedAudio(loaded.config.breakdown)}`);
  line(io, `tikhub key: ${(await tikhubKeyPresent(io.env)) ? "present" : "missing"}`);
  line(io, `project config: ${projectConfigPath(project)}`);
  const global = globalConfigPath(io.env);
  if (global !== undefined) line(io, `global config: ${global}`);
  return 0;
}

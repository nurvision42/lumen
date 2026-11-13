import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveBreakdownPrompt } from "../breakdown-prompt.js";
import {
  assignBreakdownPrompt,
  globalConfigPath,
  loadConfig,
  projectConfigPath,
  readConfigFile,
  removeBreakdownPrompt,
  writeConfigFile,
} from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagString, parseFlags, requireRestEmpty } from "../flags.js";
import { line, type IO } from "../io.js";
import { assertProject } from "../project.js";

export async function breakdownPromptCommand(
  args: string[],
  project: string,
  io: IO,
  projectSelected: boolean,
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "set") return setPrompt(rest, project, io, projectSelected);
  if (sub === "show") return showPrompt(rest, project, io);
  if (sub === "clear") return clearPrompt(rest, project, io, projectSelected);
  throw new CliError("breakdown prompt needs set, show, or clear", 2);
}

async function configFile(scope: "project" | "global", project: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (scope === "project") {
    await assertProject(project);
    return projectConfigPath(project);
  }
  const file = globalConfigPath(env);
  if (file === undefined) throw new CliError("no global config path; set HOME or XDG_CONFIG_HOME");
  return file;
}

async function setPrompt(args: string[], project: string, io: IO, projectSelected: boolean): Promise<number> {
  const { values, rest } = parseFlags(args, { file: "string", text: "string" });
  requireRestEmpty(rest);
  const file = flagString(values, "file");
  const text = flagString(values, "text");
  if (file !== undefined && text !== undefined) throw new CliError("pass --file or --text, not both", 2);
  if (file === undefined && text === undefined) throw new CliError("breakdown prompt set needs --file or --text", 2);
  let prompt: string;
  if (text !== undefined) {
    prompt = text.trim();
  } else {
    const full = path.resolve(io.cwd, file ?? "");
    if (!(await fileExists(full))) throw new CliError(`prompt file not found: ${full}`);
    prompt = (await readFile(full, "utf8")).trim();
  }
  if (prompt.length === 0) throw new CliError("prompt text is empty");
  const scope = projectSelected ? "project" : "global";
  const target = await configFile(scope, project, io.env);
  const current = await readConfigFile(target);
  assignBreakdownPrompt(current, prompt);
  await writeConfigFile(target, current);
  line(io, `set breakdown prompt (${scope}) ${target}`);
  return 0;
}

async function showPrompt(args: string[], project: string, io: IO): Promise<number> {
  const { values, rest } = parseFlags(args, { prompt: "string", "prompt-file": "string" });
  requireRestEmpty(rest);
  const loaded = await loadConfig(project, io.env);
  const resolved = await resolveBreakdownPrompt({
    project,
    flagPrompt: flagString(values, "prompt"),
    flagFile: flagString(values, "prompt-file"),
    layers: loaded.breakdownLayers,
  });
  line(io, `source: ${resolved.source}`);
  line(io, resolved.prompt);
  return 0;
}

async function clearPrompt(args: string[], project: string, io: IO, projectSelected: boolean): Promise<number> {
  const { rest } = parseFlags(args, {});
  requireRestEmpty(rest);
  const scope = projectSelected ? "project" : "global";
  const target = await configFile(scope, project, io.env);
  if (await fileExists(target)) {
    const current = await readConfigFile(target);
    if (removeBreakdownPrompt(current)) await writeConfigFile(target, current);
  }
  line(io, `cleared breakdown prompt (${scope})`);
  return 0;
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { BREAKDOWN_DEFAULT_PROMPT, isDeferredPrompt } from "./catalog.js";
import type { LumenConfig } from "./config.js";
import { CliError } from "./errors.js";
import { fileExists } from "./fsutil.js";

export const BREAKDOWN_PROMPT_SOURCES = ["flag", "project", "global", "built-in"] as const;
export type BreakdownPromptSource = (typeof BREAKDOWN_PROMPT_SOURCES)[number];

export interface ResolvedBreakdownPrompt {
  prompt: string;
  source: BreakdownPromptSource;
}

export function layerHasBreakdownPrompt(layer: LumenConfig["breakdown"]): boolean {
  if (layer.promptFile !== undefined && layer.promptFile.trim().length > 0) return true;
  return layer.prompt !== undefined && !isDeferredPrompt(layer.prompt);
}

async function readPromptFile(project: string, file: string): Promise<string> {
  const full = path.resolve(project, file);
  if (!(await fileExists(full))) throw new CliError(`prompt file not found: ${full}`);
  return (await readFile(full, "utf8")).trim();
}

function finish(prompt: string, source: BreakdownPromptSource): ResolvedBreakdownPrompt {
  if (isDeferredPrompt(prompt)) return { prompt: BREAKDOWN_DEFAULT_PROMPT, source: "built-in" };
  return { prompt, source };
}

async function fromLayer(
  project: string,
  layer: LumenConfig["breakdown"],
  source: "project" | "global",
): Promise<ResolvedBreakdownPrompt | undefined> {
  if (layer.promptFile !== undefined && layer.promptFile.trim().length > 0) {
    return finish(await readPromptFile(project, layer.promptFile), source);
  }
  if (layer.prompt !== undefined && !isDeferredPrompt(layer.prompt)) return finish(layer.prompt, source);
  return undefined;
}

/**
 * `--prompt`, then `--prompt-file`, then the whole project binding/config,
 * then the whole global binding, then the built-in 拉片 prompt.
 * A project prompt file beats a project prompt. A project prompt beats a global prompt file.
 */
export async function resolveBreakdownPrompt(input: {
  project: string;
  flagPrompt?: string;
  flagFile?: string;
  layers: { project: LumenConfig["breakdown"]; global: LumenConfig["breakdown"] };
}): Promise<ResolvedBreakdownPrompt> {
  if (input.flagPrompt !== undefined && input.flagPrompt.trim().length > 0) {
    return finish(input.flagPrompt, "flag");
  }
  if (input.flagFile !== undefined) return finish(await readPromptFile(input.project, input.flagFile), "flag");
  const projectHit = await fromLayer(input.project, input.layers.project, "project");
  if (projectHit !== undefined) return projectHit;
  const globalHit = await fromLayer(input.project, input.layers.global, "global");
  if (globalHit !== undefined) return globalHit;
  return { prompt: BREAKDOWN_DEFAULT_PROMPT, source: "built-in" };
}

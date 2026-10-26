import { readdir } from "node:fs/promises";
import path from "node:path";
import { BREAKDOWN_DEFAULT_PROMPT, isDeferredPrompt } from "../catalog.js";
import { breakdownLevel, breakdownNeedAudio, breakdownPreferModels, missingKey } from "../config.js";
import { CliError, errorCode } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagString, parseFlags, requireRestEmpty, runMode } from "../flags.js";
import type { IO } from "../io.js";
import { LAYOUT } from "../project.js";
import { settle, type OutputFile } from "../runs.js";
import { parseShotlistData } from "../shotlist.js";
import { findShots } from "../walk.js";
import { isRemoteMedia } from "../media.js";
import { runMediakit } from "../clients/mediakit.js";
import { adoptBinding } from "./session.js";
import { readFile } from "node:fs/promises";

const MODEL = "video-understand-router";
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

async function oneVideo(project: string, flag: string | undefined): Promise<string> {
  if (flag !== undefined) {
    if (isRemoteMedia(flag)) return flag;
    return path.resolve(project, flag);
  }
  const refs = path.join(project, LAYOUT.refs);
  let names: string[] = [];
  try {
    names = await readdir(refs);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
  const videos = names.filter((name) => !name.startsWith(".") && VIDEO_EXT.has(path.extname(name).toLowerCase()));
  if (videos.length !== 1 || videos[0] === undefined) {
    throw new CliError("pass --video or put exactly one video in refs/ (mp4, mov, mkv, webm, avi, m4v)");
  }
  return path.join(refs, videos[0]);
}

/** Same artifacts execute writes: understand JSON, plus a shot list when the shots validate. */
export async function materializeBreakdown(project: string, runId: string, task: unknown): Promise<OutputFile[]> {
  const understand = path.join(project, LAYOUT.refs, `${runId}.video-understand.json`);
  const files: OutputFile[] = [{ path: understand, text: `${JSON.stringify(task, null, 2)}\n` }];
  const shots = findShots(task);
  if (shots === undefined) return files;
  let parsed;
  try {
    parsed = parseShotlistData(shots, "video-understand result");
  } catch {
    return files;
  }
  if (parsed.length === 0) return files;
  const md = path.join(project, LAYOUT.shotlistMd);
  const target = (await fileExists(md))
    ? path.join(project, LAYOUT.refs, `${runId}.shotlist.json`)
    : path.join(project, LAYOUT.shotlistJson);
  files.push({ path: target, text: `${JSON.stringify(parsed, null, 2)}\n` });
  return files;
}

async function promptFrom(project: string, file: string): Promise<string> {
  const full = path.resolve(project, file);
  if (!(await fileExists(full))) throw new CliError(`prompt file not found: ${full}`);
  return (await readFile(full, "utf8")).trim();
}

export async function breakdownCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const { values, rest } = parseFlags(args, {
    video: "string",
    prompt: "string",
    "prompt-file": "string",
    "allow-placeholder": "boolean",
    "dry-run": "boolean",
    execute: "boolean",
    mock: "boolean",
  });
  requireRestEmpty(rest);
  const mode = runMode(values);
  return settle(io, project, command, MODEL, mode, async (runId, ctx) => {
    const video = await oneVideo(project, flagString(values, "video"));
    const { binding, config } = await adoptBinding(ctx, project, io.env, MODEL);
    const flagged = flagString(values, "prompt");
    const flagFile = flagString(values, "prompt-file");
    let prompt: string | undefined;
    if (flagged !== undefined && flagged.trim().length > 0) prompt = flagged;
    else if (flagFile !== undefined) prompt = await promptFrom(project, flagFile);
    else if (config.breakdown.promptFile !== undefined) prompt = await promptFrom(project, config.breakdown.promptFile);
    else if (config.breakdown.prompt !== undefined && !isDeferredPrompt(config.breakdown.prompt)) prompt = config.breakdown.prompt;
    if (prompt === undefined || isDeferredPrompt(prompt)) prompt = BREAKDOWN_DEFAULT_PROMPT;
    const preferModels = breakdownPreferModels(config.breakdown);
    const level = breakdownLevel(config.breakdown);
    const needAudio = breakdownNeedAudio(config.breakdown);
    ctx.params = { video, prompt, scene: "editing", level, preferModels, needAudio };
    if (mode === "execute" && isDeferredPrompt(prompt) && values["allow-placeholder"] !== true) {
      throw new CliError("breakdown prompt is deferred");
    }
    if (mode === "execute" && !ctx.keyPresent) throw missingKey(binding);
    if (mode === "execute" && !isRemoteMedia(video) && !(await fileExists(video))) {
      throw new CliError(`video not found: ${video}`);
    }
    const understand = path.join(project, LAYOUT.refs, `${runId}.video-understand.json`);
    ctx.resume = { videoFile: understand, receipt: understand };
    const outcome = await runMediakit(MODEL, binding, video, runId, mode, io, ctx.secret, prompt, undefined, {
      preferModels,
      level,
      needAudio,
    });
    ctx.calls = outcome.calls;
    ctx.response = outcome.response;
    if (mode !== "execute" || outcome.task === undefined) return;
    ctx.files.push(...(await materializeBreakdown(project, runId, outcome.task)));
  });
}

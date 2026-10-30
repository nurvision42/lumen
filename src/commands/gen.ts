import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertVideoProviderRules,
  canonicalModel,
  parseMediaRef,
  validateFish,
  validateImage,
  validateVideo,
  type FishModel,
} from "../catalog.js";
import { missingKey } from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagList, flagString, parseFlags, requireRestEmpty, runMode, type FlagKind } from "../flags.js";
import type { IO } from "../io.js";
import { outputPath } from "../project.js";
import { settle } from "../runs.js";
import { loadShotlist } from "../shotlist.js";
import { runFish } from "../clients/fish.js";
import { runImage } from "../clients/image.js";
import { runVideo } from "../clients/seedance.js";
import { runBeeftvVideo } from "../clients/beeftv.js";
import { runYcyapiVideo } from "../clients/ycyapi.js";
import { adoptBinding } from "./session.js";

const MODES: Record<string, FlagKind> = { "dry-run": "boolean", execute: "boolean", mock: "boolean" };

function shotNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new CliError("--shot needs a positive integer", 2);
  return Number(value);
}

async function textFromShot(project: string, shot: number, field: "frame" | "vo"): Promise<string> {
  const loaded = await loadShotlist(project);
  const found = loaded.shots.find((item) => item["#"] === shot);
  if (found === undefined) throw new CliError(`shot #${shot} is not in the shotlist`);
  const text = found[field].trim();
  if (text.length === 0) throw new CliError(`shot #${shot} has an empty ${field}`);
  return text;
}

async function readTextFile(project: string, file: string): Promise<string> {
  const full = path.resolve(project, file);
  if (!(await fileExists(full))) throw new CliError(`prompt file not found: ${full}`);
  return readFile(full, "utf8");
}

export async function genCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const kind = args[0];
  if (kind !== "image" && kind !== "video" && kind !== "voice") {
    throw new CliError("gen needs one of: image, video, voice", 2);
  }
  if (kind === "image") return genImage(args.slice(1), project, io, command);
  if (kind === "video") return genVideo(args.slice(1), project, io, command);
  return genVoice(args.slice(1), project, io, command);
}

export async function genImage(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const { values, rest } = parseFlags(args, {
    ...MODES,
    model: "string",
    shot: "string",
    prompt: "string",
    "prompt-file": "string",
    "aspect-ratio": "string",
    resolution: "string",
    background: "string",
    quality: "string",
    ref: "list",
    out: "string",
  });
  requireRestEmpty(rest);
  const modelId = flagString(values, "model");
  if (modelId === undefined) throw new CliError("gen image needs --model", 2);
  const mode = runMode(values);
  const shot = shotNumber(flagString(values, "shot"));
  return settle(io, project, command, modelId, mode, async (runId, ctx) => {
    const promptFile = flagString(values, "prompt-file");
    let prompt = flagString(values, "prompt");
    if (prompt === undefined && promptFile !== undefined) prompt = await readTextFile(project, promptFile);
    if ((prompt === undefined || prompt.trim().length === 0) && shot !== undefined) prompt = await textFromShot(project, shot, "frame");
    ctx.params = {
      prompt: prompt ?? "",
      aspectRatio: flagString(values, "aspect-ratio") ?? "auto",
      resolution: flagString(values, "resolution") ?? "1K",
      references: flagList(values, "ref"),
    };
    const request = validateImage({
      modelId,
      prompt: prompt ?? "",
      aspectRatio: flagString(values, "aspect-ratio") ?? "auto",
      resolution: flagString(values, "resolution") ?? "1K",
      background: flagString(values, "background"),
      quality: flagString(values, "quality"),
      references: flagList(values, "ref"),
    });
    ctx.params = request;
    const { binding } = await adoptBinding(ctx, project, io.env, modelId);
    if (mode === "execute" && !ctx.keyPresent) throw missingKey(binding);
    const out = outputPath(project, { shot, folder: "frame", filename: `${runId}.png`, out: flagString(values, "out") });
    const outcome = await runImage(request, binding, mode, io, ctx.secret, out);
    ctx.calls = outcome.calls;
    ctx.response = outcome.response;
    ctx.files = outcome.files;
  });
}

export async function genVideo(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const { values, rest } = parseFlags(args, {
    ...MODES,
    model: "string",
    shot: "string",
    prompt: "string",
    "prompt-file": "string",
    shape: "string",
    duration: "string",
    resolution: "string",
    "aspect-ratio": "string",
    "generate-audio": "boolean",
    "web-search": "boolean",
    "first-frame": "string",
    "first-person": "string",
    "last-frame": "string",
    "last-person": "string",
    "task-type": "string",
    ref: "list",
    out: "string",
  });
  requireRestEmpty(rest);
  const requested = flagString(values, "model");
  if (requested === undefined) throw new CliError("gen video needs --model", 2);
  const modelId = canonicalModel(requested);
  const mode = runMode(values);
  const shot = shotNumber(flagString(values, "shot"));
  return settle(io, project, command, modelId, mode, async (runId, ctx) => {
    let prompt = flagString(values, "prompt");
    const promptFile = flagString(values, "prompt-file");
    if (prompt === undefined && promptFile !== undefined) prompt = await readTextFile(project, promptFile);
    if ((prompt === undefined || prompt.trim().length === 0) && shot !== undefined) prompt = await textFromShot(project, shot, "frame");
    ctx.params = {
      shape: flagString(values, "shape"),
      prompt: prompt ?? "",
      duration: flagString(values, "duration"),
      references: flagList(values, "ref"),
      taskType: flagString(values, "task-type"),
    };
    const request = validateVideo({
      modelId,
      shape: flagString(values, "shape"),
      prompt: prompt ?? "",
      duration: flagString(values, "duration"),
      resolution: flagString(values, "resolution"),
      aspectRatio: flagString(values, "aspect-ratio"),
      generateAudio: values["generate-audio"] === true,
      webSearch: values["web-search"] === true,
      firstFrame: flagString(values, "first-frame"),
      firstPerson: flagString(values, "first-person"),
      lastFrame: flagString(values, "last-frame"),
      lastPerson: flagString(values, "last-person"),
      references: flagList(values, "ref").map(parseMediaRef),
      taskType: flagString(values, "task-type"),
    });
    ctx.params = request;
    const { binding, config } = await adoptBinding(ctx, project, io.env, modelId);
    assertVideoProviderRules(request, binding.provider);
    if (mode === "execute" && !ctx.keyPresent) throw missingKey(binding);
    const videoFile = outputPath(project, {
      shot,
      folder: "clip",
      filename: `${runId}.mp4`,
      out: flagString(values, "out"),
    });
    const receipt = `${videoFile.replace(/\.mp4$/i, "")}.seedance.json`;
    ctx.resume = { videoFile, receipt };
    let outcome;
    if (binding.provider === "beeftv") {
      outcome = await runBeeftvVideo(request, binding, mode, io, ctx.secret, videoFile, receipt);
    } else if (binding.provider === "ycyapi") {
      outcome = await runYcyapiVideo(request, binding, mode, io, ctx.secret, videoFile, receipt, config);
    } else {
      outcome = await runVideo(request, binding, mode, io, ctx.secret, videoFile, receipt);
    }
    ctx.calls = outcome.calls;
    ctx.response = outcome.response;
    ctx.files = outcome.files;
  });
}

export async function genVoice(
  args: string[],
  project: string,
  io: IO,
  command: string[],
  implied?: FishModel,
): Promise<number> {
  const { values, rest } = parseFlags(args, {
    ...MODES,
    model: "string",
    shot: "string",
    instruction: "string",
    text: "string",
    speech: "string",
    "text-file": "string",
    voice: "string",
    title: "string",
    out: "string",
  });
  requireRestEmpty(rest);
  const flagged = flagString(values, "model");
  if (implied !== undefined && flagged !== undefined && flagged !== implied) {
    throw new CliError(`--model ${flagged} does not match ${implied}`, 2);
  }
  const modelId = flagged ?? implied;
  if (modelId === undefined) throw new CliError("gen voice needs --model", 2);
  const mode = runMode(values);
  const shot = shotNumber(flagString(values, "shot"));
  return settle(io, project, command, modelId, mode, async (runId, ctx) => {
    let text = flagString(values, "text") ?? flagString(values, "speech");
    const textFile = flagString(values, "text-file");
    if (text === undefined && textFile !== undefined) text = (await readTextFile(project, textFile)).trim();
    if ((text === undefined || text.trim().length === 0) && shot !== undefined && modelId !== "voice-design-1") {
      text = await textFromShot(project, shot, "vo");
    }
    ctx.params = { instruction: flagString(values, "instruction"), text, voice: flagString(values, "voice") };
    const request = validateFish({
      modelId,
      instruction: flagString(values, "instruction"),
      text,
      voice: flagString(values, "voice"),
      title: flagString(values, "title"),
    });
    ctx.params = request;
    const { binding } = await adoptBinding(ctx, project, io.env, modelId);
    if (mode === "execute" && !ctx.keyPresent) throw missingKey(binding);
    const out = outputPath(project, { shot, folder: "vo", filename: `${runId}.mp3`, out: flagString(values, "out") });
    const outcome = await runFish(request, binding, mode, io, ctx.secret, runId, out);
    ctx.calls = outcome.calls;
    ctx.response = outcome.response;
    ctx.files = outcome.files;
  });
}

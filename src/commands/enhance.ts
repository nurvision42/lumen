import path from "node:path";
import { canonicalModel } from "../catalog.js";
import { missingKey } from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagString, parseFlags, requireRestEmpty, runMode } from "../flags.js";
import { fetchOf, perform, type HttpCall } from "../http.js";
import type { IO } from "../io.js";
import { isRemoteMedia } from "../media.js";
import { LAYOUT, outputPath } from "../project.js";
import { settle, type OutputFile } from "../runs.js";
import { resolveEnhance, runMediakit, type EnhanceTool } from "../clients/mediakit.js";
import { adoptBinding } from "./session.js";
import { readdir } from "node:fs/promises";
import { errorCode } from "../errors.js";

const DEFAULT_MODEL: EnhanceTool = "enhance-video";
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

function shotNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new CliError("--shot needs a positive integer", 2);
  return Number(value);
}

function enhanceModel(value: string | undefined): EnhanceTool {
  const id = value === undefined ? DEFAULT_MODEL : canonicalModel(value);
  if (id !== "enhance-video" && id !== "enhance-video-generative") {
    throw new CliError("--model must be enhance-video or enhance-video-generative", 2);
  }
  return id;
}

/** https results become the mp4; vod/tos/mediakit URIs are recorded and not turned into a fake file. */
export async function materializeEnhance(
  videoUrl: string,
  calls: HttpCall[],
  io: IO,
  paths: { videoFile: string; receipt: string },
): Promise<OutputFile[]> {
  if (/^https?:\/\//i.test(videoUrl)) {
    const downloaded = await perform(
      calls,
      { method: "GET", url: videoUrl, headers: {}, body: { kind: "empty" } },
      { mode: "execute", fetchImpl: fetchOf(io), auth: false },
    );
    return [{ path: paths.videoFile, bytes: downloaded.body }];
  }
  return [{ path: paths.receipt, text: `${JSON.stringify({ video_url: videoUrl }, null, 2)}\n` }];
}

function parseFps(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new CliError("--fps needs a number from 15 to 120", 2);
  const fps = Number(value);
  if (fps < 15 || fps > 120) throw new CliError("--fps needs a number from 15 to 120", 2);
  return fps;
}

export async function enhanceCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const { values, rest } = parseFlags(args, {
    model: "string",
    video: "string",
    shot: "string",
    out: "string",
    "tool-version": "string",
    scene: "string",
    resolution: "string",
    "enhance-style": "string",
    fps: "string",
    "bitrate-level": "string",
    "dry-run": "boolean",
    execute: "boolean",
    mock: "boolean",
  });
  requireRestEmpty(rest);
  const mode = runMode(values);
  const shot = shotNumber(flagString(values, "shot"));
  const model = enhanceModel(flagString(values, "model"));
  const fps = parseFps(flagString(values, "fps"));
  const enhance = resolveEnhance({
    ...(flagString(values, "tool-version") === undefined ? {} : { toolVersion: flagString(values, "tool-version") }),
    ...(flagString(values, "scene") === undefined ? {} : { scene: flagString(values, "scene") }),
    ...(flagString(values, "resolution") === undefined ? {} : { resolution: flagString(values, "resolution") }),
    ...(flagString(values, "enhance-style") === undefined ? {} : { enhanceStyle: flagString(values, "enhance-style") }),
    ...(flagString(values, "bitrate-level") === undefined ? {} : { bitrateLevel: flagString(values, "bitrate-level") }),
    ...(fps === undefined ? {} : { fps }),
  }, model);
  return settle(io, project, command, model, mode, async (runId, ctx) => {
    const video = await oneVideo(project, flagString(values, "video"));
    ctx.params = { video, model, ...enhance };
    const { binding } = await adoptBinding(ctx, project, io.env, model);
    if (mode === "execute" && !ctx.keyPresent) throw missingKey(binding);
    if (mode === "execute" && !isRemoteMedia(video) && !(await fileExists(video))) {
      throw new CliError(`video not found: ${video}`);
    }
    const videoFile = outputPath(project, {
      shot,
      folder: "clip",
      filename: `enhance-${runId}.mp4`,
      out: flagString(values, "out"),
    });
    const receipt = path.join(project, LAYOUT.refs, `${runId}.enhance.json`);
    ctx.resume = { videoFile, receipt };
    const outcome = await runMediakit(model, binding, video, runId, mode, io, ctx.secret, undefined, enhance);
    ctx.calls = outcome.calls;
    ctx.response = outcome.response;
    if (mode !== "execute" || outcome.videoUrl === undefined) return;
    ctx.files.push(...(await materializeEnhance(outcome.videoUrl, ctx.calls, io, { videoFile, receipt })));
  });
}

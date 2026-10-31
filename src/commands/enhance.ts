import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, missingKey } from "../config.js";
import { enhanceCost } from "../enhance/cost.js";
import { CliError, errorCode } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagString, parseFlags, requireRestEmpty, runMode } from "../flags.js";
import { applyFilmGrain, BITRATE_FALLBACK_NOTE } from "../grain/apply.js";
import { fetchOf, perform, type HttpCall } from "../http.js";
import { line, type IO } from "../io.js";
import { isRemoteMedia } from "../media.js";
import { LAYOUT, outputPath } from "../project.js";
import { settle, type OutputFile } from "../runs.js";
import { resolveEnhance, runMediakit } from "../clients/mediakit.js";
import { probeDuration } from "../sprite/media.js";
import { requireBinary } from "../tools/resolve.js";
import { adoptBinding } from "./session.js";

const MODEL = "enhance-video-generative";
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

async function sourceDuration(project: string, video: string, io: IO): Promise<number | undefined> {
  if (isRemoteMedia(video) || !(await fileExists(video))) return undefined;
  try {
    const loaded = await loadConfig(project, io.env);
    const ffprobe = await requireBinary("ffprobe", io.env, loaded.config.tools, true, io.fetch, (name) => {
      io.stderr(`downloading ${name}\n`);
    });
    return await probeDuration(ffprobe.path, video);
  } catch (err) {
    if (err instanceof CliError && err.message.includes("was not found")) throw err;
    return undefined;
  }
}

/** https results are grained, then saved as the mp4. vod/tos/mediakit URIs are recorded and not turned into a fake file. */
export async function materializeEnhance(
  videoUrl: string,
  calls: HttpCall[],
  io: IO,
  project: string,
  paths: { videoFile: string; receipt: string },
): Promise<OutputFile[]> {
  if (/^https?:\/\//i.test(videoUrl)) {
    const downloaded = await perform(
      calls,
      { method: "GET", url: videoUrl, headers: {}, body: { kind: "empty" } },
      { mode: "execute", fetchImpl: fetchOf(io), auth: false },
    );
    const loaded = await loadConfig(project, io.env);
    const note = (name: "ffmpeg" | "ffprobe"): void => {
      io.stderr(`downloading ${name}\n`);
    };
    const ffmpeg = await requireBinary("ffmpeg", io.env, loaded.config.tools, true, io.fetch, note);
    const ffprobe = await requireBinary("ffprobe", io.env, loaded.config.tools, true, io.fetch, note);
    const dir = await mkdtemp(path.join(tmpdir(), "lumen-enhance-"));
    try {
      const raw = path.join(dir, "enhanced.mp4");
      await writeFile(raw, downloaded.body);
      await mkdir(path.dirname(paths.videoFile), { recursive: true });
      const plan = await applyFilmGrain({
        ffmpeg: ffmpeg.path,
        ffprobe: ffprobe.path,
        source: raw,
        output: paths.videoFile,
      });
      if (plan.bitrate.source === "format") line(io, BITRATE_FALLBACK_NOTE);
      return [{ path: paths.videoFile }];
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return [{ path: paths.receipt, text: `${JSON.stringify({ video_url: videoUrl }, null, 2)}\n` }];
}

export async function enhanceCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const { values, rest } = parseFlags(args, {
    video: "string",
    shot: "string",
    out: "string",
    "dry-run": "boolean",
    execute: "boolean",
    mock: "boolean",
  });
  requireRestEmpty(rest);
  const mode = runMode(values);
  const shot = shotNumber(flagString(values, "shot"));
  const enhance = resolveEnhance(undefined, MODEL);
  return settle(io, project, command, MODEL, mode, async (runId, ctx) => {
    const video = await oneVideo(project, flagString(values, "video"));
    const cost = enhanceCost(await sourceDuration(project, video, io));
    line(io, cost.text);
    ctx.params = {
      video,
      model: MODEL,
      resolution: enhance.resolution,
      fps: enhance.fps,
      yuanPerMin: cost.yuanPerMin,
      ...(cost.minutes === undefined ? {} : { minutes: cost.minutes, yuan: cost.yuan }),
    };
    const { binding } = await adoptBinding(ctx, project, io.env, MODEL);
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
    const outcome = await runMediakit(MODEL, binding, video, runId, mode, io, ctx.secret, undefined, enhance);
    ctx.calls = outcome.calls;
    ctx.response = outcome.response;
    if (mode !== "execute" || outcome.videoUrl === undefined) return;
    ctx.files.push(...(await materializeEnhance(outcome.videoUrl, ctx.calls, io, project, { videoFile, receipt })));
  });
}

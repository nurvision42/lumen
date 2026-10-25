import path from "node:path";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagString, parseFlags, requireRestEmpty } from "../flags.js";
import { line, type IO } from "../io.js";
import { detectCuts } from "../sprite/media.js";
import { formatTime } from "../sprite/select.js";
import { requireBinary } from "../tools/resolve.js";

export async function cutsCommand(args: string[], project: string, io: IO): Promise<number> {
  const { values, rest } = parseFlags(args, {
    video: "string",
    "sample-rate": "string",
    threshold: "string",
    json: "boolean",
  });
  requireRestEmpty(rest);
  const videoFlag = flagString(values, "video");
  if (videoFlag === undefined || videoFlag.trim().length === 0) throw new CliError("cuts requires --video <file>", 2);
  const video = path.resolve(project, videoFlag.trim());
  if (!(await fileExists(video))) throw new CliError(`video not found: ${video}`);
  const thresholdText = flagString(values, "threshold");
  const threshold = thresholdText === undefined ? 0.4 : Number(thresholdText);
  if (!Number.isFinite(threshold)) throw new CliError("--threshold must be a number", 2);
  const rateText = flagString(values, "sample-rate");
  const sampleRate = rateText === undefined ? undefined : Number(rateText);
  if (sampleRate !== undefined && !Number.isFinite(sampleRate)) throw new CliError("--sample-rate must be a number", 2);
  const loaded = await loadConfig(project, io.env);
  const note = (name: "ffmpeg" | "ffprobe"): void => {
    io.stderr(`downloading ${name}\n`);
  };
  const ffmpeg = await requireBinary("ffmpeg", io.env, loaded.config.tools, true, io.fetch, note);
  const cuts = await detectCuts(ffmpeg.path, video, threshold, sampleRate);
  if (values.json === true) {
    line(io, JSON.stringify({
      format: "lumen.cuts@1",
      video,
      threshold,
      sampleRate: sampleRate ?? null,
      ffmpeg: { path: ffmpeg.path, version: ffmpeg.version, source: ffmpeg.source },
      cuts: cuts.map((cut) => ({ time: cut.time, score: cut.score })),
    }, null, 2));
    return 0;
  }
  if (cuts.length === 0) {
    line(io, "no cuts");
    return 0;
  }
  for (const cut of cuts) line(io, `${formatTime(cut.time)} score=${cut.score.toFixed(3)}`);
  return 0;
}

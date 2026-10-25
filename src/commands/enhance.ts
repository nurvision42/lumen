import path from "node:path";
import { missingKey } from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagString, parseFlags, requireRestEmpty, runMode } from "../flags.js";
import { fetchOf, perform } from "../http.js";
import type { IO } from "../io.js";
import { isRemoteMedia } from "../media.js";
import { LAYOUT, outputPath } from "../project.js";
import { settle } from "../runs.js";
import { runMediakit } from "../clients/mediakit.js";
import { adoptBinding } from "./session.js";
import { readdir } from "node:fs/promises";
import { errorCode } from "../errors.js";

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

export async function enhanceCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const { values, rest } = parseFlags(args, {
    video: "string",
    shot: "string",
    out: "string",
    "tool-version": "string",
    scene: "string",
    resolution: "string",
    "enhance-style": "string",
    "dry-run": "boolean",
    execute: "boolean",
    mock: "boolean",
  });
  requireRestEmpty(rest);
  const mode = runMode(values);
  const shot = shotNumber(flagString(values, "shot"));
  return settle(io, project, command, MODEL, mode, async (runId, ctx) => {
    const video = await oneVideo(project, flagString(values, "video"));
    const enhance = {
      ...(flagString(values, "tool-version") === undefined ? {} : { toolVersion: flagString(values, "tool-version") }),
      ...(flagString(values, "scene") === undefined ? {} : { scene: flagString(values, "scene") }),
      ...(flagString(values, "resolution") === undefined ? {} : { resolution: flagString(values, "resolution") }),
      ...(flagString(values, "enhance-style") === undefined ? {} : { enhanceStyle: flagString(values, "enhance-style") }),
    };
    ctx.params = { video, ...enhance };
    const { binding } = await adoptBinding(ctx, project, io.env, MODEL);
    if (mode === "execute" && !ctx.keyPresent) throw missingKey(binding);
    if (mode === "execute" && !isRemoteMedia(video) && !(await fileExists(video))) {
      throw new CliError(`video not found: ${video}`);
    }
    const outcome = await runMediakit(MODEL, binding, video, runId, mode, io, ctx.secret, undefined, enhance);
    ctx.calls = outcome.calls;
    ctx.response = outcome.response;
    if (mode !== "execute" || outcome.videoUrl === undefined) return;
    if (/^https?:\/\//i.test(outcome.videoUrl)) {
      const downloaded = await perform(
        ctx.calls,
        { method: "GET", url: outcome.videoUrl, headers: {}, body: { kind: "empty" } },
        { mode: "execute", fetchImpl: fetchOf(io), auth: false },
      );
      const out = outputPath(project, {
        shot,
        folder: "clip",
        filename: `enhance-${runId}.mp4`,
        out: flagString(values, "out"),
      });
      ctx.files.push({ path: out, bytes: downloaded.body });
      return;
    }
    const note = path.join(project, LAYOUT.refs, `${runId}.enhance.json`);
    ctx.files.push({ path: note, text: `${JSON.stringify({ video_url: outcome.videoUrl }, null, 2)}\n` });
  });
}

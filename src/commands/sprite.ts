import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagList, flagString, parseFlags } from "../flags.js";
import { line, type IO } from "../io.js";
import { findCjkFont, pagePaths, renderPages } from "../sprite/layout.js";
import { detectCuts, extractFrame, listFrameTimes, probeDuration, snapSamples } from "../sprite/media.js";
import {
  clipSpan,
  everyTimes,
  FALLBACK_EVERY,
  midpointTimes,
  parseTime,
  roundTime,
  samplesForSpan,
  type Sample,
  type Span,
} from "../sprite/select.js";
import { discoverShots, loadSpans, parseRanges, spansFromCuts } from "../sprite/shots.js";
import { requireBinary, resolveSharp, type ResolvedBinary, type ResolvedSharp } from "../tools/resolve.js";

function integerOption(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new CliError(`${name} must be a positive integer`, 2);
  const parsed = Number(value);
  if (parsed < 1) throw new CliError(`${name} must be a positive integer`, 2);
  return parsed;
}

function timeOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseTime(value);
  if (parsed < 0) throw new CliError(`${name} must be zero or greater`, 2);
  return parsed;
}

function clipAll(spans: readonly Span[], start: number | undefined, end: number | undefined): Span[] {
  return spans.map((span) => clipSpan(span, start, end)).filter((span): span is Span => span !== undefined);
}

function withoutText(samples: readonly Sample[]): Sample[] {
  return samples.map((sample) => ({
    time: sample.time,
    ...(sample.id === undefined ? {} : { id: sample.id }),
  }));
}

function applyTranscript(samples: readonly Sample[], cues: readonly Span[]): Sample[] {
  return samples.map((sample) => {
    const cue = cues.find((item) => item.text !== undefined && sample.time >= item.start && sample.time < item.end + 1e-3);
    return {
      time: sample.time,
      ...(sample.id === undefined ? {} : { id: sample.id }),
      ...(cue?.text === undefined ? {} : { text: cue.text }),
    };
  });
}

export async function spriteCommand(args: string[], project: string, io: IO): Promise<number> {
  const { values, rest } = parseFlags(args, {
    video: "string",
    to: "string",
    every: "string",
    frames: "string",
    "every-frame": "boolean",
    at: "list",
    start: "string",
    end: "string",
    ranges: "string",
    shots: "string",
    columns: "string",
    rows: "string",
    cell: "string",
    transcript: "string",
    json: "boolean",
  });
  if (rest.length > 0) throw new CliError(`unexpected argument: ${rest[0]}`, 2);
  const videoFlag = flagString(values, "video");
  const toFlag = flagString(values, "to");
  if (videoFlag === undefined || videoFlag.trim().length === 0) throw new CliError("sprite requires --video <file>", 2);
  if (toFlag === undefined || toFlag.trim().length === 0) throw new CliError("sprite requires --to <path>", 2);
  const at = flagList(values, "at");
  const selectors = [
    flagString(values, "every") === undefined ? undefined : "every",
    flagString(values, "frames") === undefined ? undefined : "frames",
    values["every-frame"] === true ? "every-frame" : undefined,
    at.length > 0 ? "at" : undefined,
    flagString(values, "ranges") === undefined ? undefined : "ranges",
  ].filter((item): item is string => item !== undefined);
  if (selectors.length > 1) throw new CliError("choose one of --every, --frames, --every-frame, --at, --ranges", 2);
  const shotsFlag = flagString(values, "shots");
  if (shotsFlag !== undefined && selectors.length > 0) {
    throw new CliError("--shots cannot be combined with another frame selector", 2);
  }
  const columns = integerOption(flagString(values, "columns"), "--columns", 3);
  const rows = integerOption(flagString(values, "rows"), "--rows", 3);
  const cell = integerOption(flagString(values, "cell"), "--cell", 320);
  const windowStart = timeOption(flagString(values, "start"), "--start");
  const windowEnd = timeOption(flagString(values, "end"), "--end");
  if (windowStart !== undefined && windowEnd !== undefined && !(windowEnd > windowStart)) {
    throw new CliError("--end must be after --start", 2);
  }

  const video = path.resolve(project, videoFlag.trim());
  if (!(await fileExists(video))) throw new CliError(`video not found: ${video}`);
  const target = path.resolve(project, toFlag.trim());
  const loaded = await loadConfig(project, io.env);
  const note = (name: "ffmpeg" | "ffprobe"): void => {
    io.stderr(`downloading ${name}\n`);
  };
  const ffmpeg = await requireBinary("ffmpeg", io.env, loaded.config.tools, true, io.fetch, note);
  const ffprobe = await requireBinary("ffprobe", io.env, loaded.config.tools, true, io.fetch, note);
  const duration = await probeDuration(ffprobe.path, video);
  const chosen = await chooseSamples({
    mode: selectors[0],
    project,
    video,
    duration,
    ffmpeg,
    ffprobe,
    windowStart,
    windowEnd,
    every: flagString(values, "every"),
    frames: flagString(values, "frames"),
    at,
    ranges: flagString(values, "ranges"),
    shots: shotsFlag,
  });
  if (chosen.samples.length === 0) throw new CliError("no frames selected");
  const snapped = await snapSamples(ffprobe.path, video, chosen.samples);
  const transcript = flagString(values, "transcript");
  const labeled = transcript === undefined ? withoutText(snapped) : applyTranscript(snapped, await loadSpans(path.resolve(project, transcript)));
  const temp = await mkdtemp(path.join(tmpdir(), "lumen-sprite-"));
  try {
    const frames = [];
    for (let index = 0; index < labeled.length; index += 1) {
      const sample = labeled[index];
      if (sample === undefined) continue;
      const file = path.join(temp, `${String(index).padStart(4, "0")}.png`);
      await extractFrame(ffmpeg.path, video, sample.time, file);
      frames.push({ file, sample });
    }
    const sharp = await resolveSharp({
      env: io.env,
      project,
      cwd: io.cwd,
      download: true,
      ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
      onDownload: () => {
        io.stderr("downloading sharp\n");
      },
    });
    if (sharp === undefined) throw new CliError("sharp was not found and could not be installed");
    const pages = pagePaths(target, Math.ceil(frames.length / (columns * rows)));
    for (const page of pages) {
      if (await fileExists(page)) throw new CliError(`sprite refused to overwrite ${page}`);
    }
    const fontFile = await findCjkFont();
    const buffers = await renderPages(await sharp.load(), frames, {
      columns,
      rows,
      cell,
      ...(fontFile === undefined ? {} : { fontFile }),
    });
    await writePages(pages, buffers);
    writeReport(io, values.json === true, {
      video,
      mode: chosen.mode,
      pages,
      frames: labeled,
      ffmpeg,
      ffprobe,
      sharp,
      ...(chosen.shots === undefined ? {} : { shots: chosen.shots }),
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return 0;
}

async function chooseSamples(input: {
  readonly mode: string | undefined;
  readonly project: string;
  readonly video: string;
  readonly duration: number;
  readonly ffmpeg: ResolvedBinary;
  readonly ffprobe: ResolvedBinary;
  readonly windowStart: number | undefined;
  readonly windowEnd: number | undefined;
  readonly every: string | undefined;
  readonly frames: string | undefined;
  readonly at: readonly string[];
  readonly ranges: string | undefined;
  readonly shots: string | undefined;
}): Promise<{ mode: string; samples: Sample[]; shots?: string }> {
  const start = input.windowStart ?? 0;
  const end = Math.min(input.duration, input.windowEnd ?? input.duration);
  if (!(end > start)) throw new CliError("the selected window is empty");
  if (input.mode === "ranges") {
    const spans = clipAll(parseRanges(input.ranges ?? "[]"), input.windowStart, input.windowEnd ?? input.duration);
    return { mode: "ranges", samples: spans.flatMap(samplesForSpan) };
  }
  if (input.mode === "at") {
    const times = input.at.flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value.length > 0).map(parseTime);
    for (const time of times) {
      if (time < 0 || time > input.duration) throw new CliError(`--at ${time} is outside the video`);
    }
    const kept = times.filter((time) => time >= start && time < end);
    return { mode: "at", samples: kept.map((time) => ({ time: roundTime(time) })) };
  }
  if (input.mode === "every-frame") {
    const times = (await listFrameTimes(input.ffprobe.path, input.video)).filter((time) => time >= start && time < end);
    return { mode: "every-frame", samples: times.map((time) => ({ time })) };
  }
  if (input.mode === "frames") {
    const count = integerOption(input.frames, "--frames", 0);
    return { mode: "frames", samples: midpointTimes(start, end, count).map((time) => ({ time })) };
  }
  if (input.mode === "every") {
    const every = timeOption(input.every, "--every");
    if (every === undefined || !(every > 0)) throw new CliError("--every must be greater than 0", 2);
    return { mode: "every", samples: everyTimes(start, end, every).map((time) => ({ time })) };
  }
  const explicit = input.shots === undefined ? undefined : await loadSpans(path.resolve(input.project, input.shots));
  const discovered = explicit === undefined ? await discoverShots(input.project) : undefined;
  const shotSpans = explicit ?? discovered?.spans;
  if (shotSpans !== undefined) {
    const spans = clipAll(shotSpans, input.windowStart, input.windowEnd ?? input.duration);
    if (spans.length === 0) throw new CliError("no shots fall inside the selected window");
    return {
      mode: "shots",
      samples: spans.flatMap(samplesForSpan),
      ...(discovered?.file === undefined ? {} : { shots: discovered.file }),
      ...(input.shots === undefined ? {} : { shots: path.resolve(input.project, input.shots) }),
    };
  }
  const cuts = await detectCuts(input.ffmpeg.path, input.video, 0.4, undefined);
  const scene = spansFromCuts(input.duration, cuts);
  if (scene !== undefined) {
    const spans = clipAll(scene, input.windowStart, input.windowEnd ?? input.duration);
    if (spans.length > 0) return { mode: "scene", samples: spans.flatMap(samplesForSpan) };
  }
  return { mode: "interval", samples: everyTimes(start, end, FALLBACK_EVERY).map((time) => ({ time })) };
}

async function writePages(pages: readonly string[], buffers: readonly Buffer[]): Promise<void> {
  const written: string[] = [];
  let current = "the output";
  try {
    for (let index = 0; index < buffers.length; index += 1) {
      const page = pages[index];
      const buffer = buffers[index];
      if (page === undefined || buffer === undefined) continue;
      current = page;
      await writeFile(page, buffer, { flag: "wx" });
      written.push(page);
    }
  } catch (error) {
    await Promise.all(written.map((file) => rm(file, { force: true })));
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new CliError(`sprite refused to overwrite ${current}`);
    throw error;
  }
}

function writeReport(io: IO, json: boolean, report: {
  readonly video: string;
  readonly mode: string;
  readonly pages: readonly string[];
  readonly frames: readonly Sample[];
  readonly ffmpeg: ResolvedBinary;
  readonly ffprobe: ResolvedBinary;
  readonly sharp: ResolvedSharp;
  readonly shots?: string;
}): void {
  if (json) {
    line(io, JSON.stringify({
      format: "lumen.sprite@1",
      video: report.video,
      mode: report.mode,
      ...(report.shots === undefined ? {} : { shots: report.shots }),
      pages: report.pages,
      frames: report.frames.map((frame) => ({
        time: roundTime(frame.time),
        ...(frame.id === undefined ? {} : { shot: frame.id }),
        ...(frame.text === undefined ? {} : { transcript: frame.text }),
      })),
      ffmpeg: { path: report.ffmpeg.path, version: report.ffmpeg.version, source: report.ffmpeg.source },
      ffprobe: { path: report.ffprobe.path, version: report.ffprobe.version, source: report.ffprobe.source },
      sharp: { path: report.sharp.path, version: report.sharp.version, source: report.sharp.source },
    }, null, 2));
    return;
  }
  for (const page of report.pages) line(io, `已保存到 ${page}`);
}

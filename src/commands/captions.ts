import { readFile } from "node:fs/promises";
import path from "node:path";
import { runAsr, assertAsrLanguage, type AsrOptions } from "../clients/asr.js";
import { burnCaptions, parseBurnColor, probeVideo, resolveBurnPlan, type BurnStyle } from "../captions/burn.js";
import {
  cuesFromTask,
  parseAss,
  parseTimedText,
  readCueDocument,
  reconcileCaptions,
  toAss,
  toReadable,
  toSrt,
  type CaptionFile,
  type Cue,
  type CueDocument,
} from "../captions/cues.js";
import { discoverScript, loadScriptFile, type ScriptCopy } from "../captions/script.js";
import { loadConfig, missingKey } from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagString, parseFlags, requireRestEmpty, runMode } from "../flags.js";
import { line, type IO } from "../io.js";
import { isRemoteMedia } from "../media.js";
import { LAYOUT } from "../project.js";
import { settle } from "../runs.js";
import { probeDuration } from "../sprite/media.js";
import { roundTime } from "../sprite/select.js";
import { requireBinary } from "../tools/resolve.js";
import { adoptBinding } from "./session.js";
import { BACKGROUND_COLOR, TEXT_COLOR, parseFactor, parseFontSize, parseMargin, parsePosition } from "../captions/style.js";

const MODEL = "asr-subtitles";

function textSibling(jsonPath: string): string {
  const ext = path.extname(jsonPath);
  const base = ext.toLowerCase() === ".json" ? jsonPath.slice(0, -ext.length) : jsonPath;
  return `${base}.txt`;
}

async function refuseExisting(files: readonly string[]): Promise<void> {
  for (const file of files) {
    if (await fileExists(file)) throw new CliError(`refused to overwrite ${file}`);
  }
}

function summary(file: CaptionFile): string[] {
  const script = file.script === null
    ? "script: none"
    : `script: ${file.script.source} fit=${file.script.fit.toFixed(3)} applied=${file.script.applied ? "yes" : "no"}`;
  return [
    `duration: ${file.duration.toFixed(3)}`,
    `clamped: ${file.clamped ? "yes" : "no"}`,
    `confirmed: ${file.confirmed ? "yes" : "no"}`,
    script,
    `cues: ${file.cues.length}`,
  ];
}

export async function transcribeCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const { values, rest } = parseFlags(args, {
    video: "string",
    script: "string",
    "no-script": "boolean",
    to: "string",
    srt: "string",
    ass: "string",
    language: "string",
    speaker: "boolean",
    "dry-run": "boolean",
    execute: "boolean",
    mock: "boolean",
  });
  requireRestEmpty(rest);
  const mode = runMode(values);
  const videoFlag = flagString(values, "video");
  if (videoFlag === undefined || videoFlag.trim().length === 0) {
    throw new CliError("captions transcribe requires --video <file>", 2);
  }
  if (values["no-script"] === true && flagString(values, "script") !== undefined) {
    throw new CliError("pass either --script or --no-script", 2);
  }
  const language = assertAsrLanguage(flagString(values, "language"));
  const options: AsrOptions = { speaker: values.speaker === true, ...(language === undefined ? {} : { language }) };
  const video = isRemoteMedia(videoFlag.trim()) ? videoFlag.trim() : path.resolve(project, videoFlag.trim());

  return settle(io, project, command, MODEL, mode, async (runId, ctx) => {
    const scriptFlag = flagString(values, "script");
    let script: ScriptCopy | undefined;
    if (scriptFlag !== undefined) script = await loadScriptFile(path.resolve(project, scriptFlag));
    else if (values["no-script"] !== true) script = await discoverScript(project);
    const jsonPath = path.resolve(project, flagString(values, "to") ?? path.join(LAYOUT.refs, `${runId}.captions.json`));
    const txtPath = textSibling(jsonPath);
    const srtFlag = flagString(values, "srt");
    const assFlag = flagString(values, "ass");
    const srtPath = srtFlag === undefined ? undefined : path.resolve(project, srtFlag);
    const assPath = assFlag === undefined ? undefined : path.resolve(project, assFlag);
    const outputs = [jsonPath, txtPath, ...(srtPath === undefined ? [] : [srtPath]), ...(assPath === undefined ? [] : [assPath])];
    ctx.params = {
      video,
      language: options.language ?? null,
      speaker: options.speaker,
      script: script === undefined ? null : { source: script.source, file: script.file, timed: script.timed },
      outputs,
      clamp: "on execute, each end is limited to the probed file duration",
    };
    const { binding } = await adoptBinding(ctx, project, io.env, MODEL);
    if (mode === "execute") {
      if (!ctx.keyPresent) throw missingKey(binding);
      if (!isRemoteMedia(video) && !(await fileExists(video))) throw new CliError(`video not found: ${video}`);
      await refuseExisting(outputs);
    }
    let probed: number | undefined;
    if (mode !== "dry-run" && !isRemoteMedia(video)) {
      const loaded = await loadConfig(project, io.env);
      const ffprobe = await requireBinary("ffprobe", io.env, loaded.config.tools, true, io.fetch, (name) => {
        io.stderr(`downloading ${name}\n`);
      });
      probed = await probeDuration(ffprobe.path, video);
    }
    const outcome = await runAsr(binding, video, runId, mode, io, ctx.secret, options);
    ctx.calls = outcome.calls;
    if (mode === "dry-run") {
      for (const row of [
        `video: ${video}`,
        `script: ${script === undefined ? "none" : `${script.source} ${script.file}`}`,
        `json: ${jsonPath}`,
        `text: ${txtPath}`,
      ]) line(io, row);
      return;
    }
    const recognized = cuesFromTask(outcome.task);
    const duration = probed ?? recognized.duration;
    if (duration === undefined || !(duration > 0)) throw new CliError(`could not read a duration from ${video}`);
    if (recognized.cues.length === 0 && script?.timed !== true) throw new CliError("MediaKit ASR returned no subtitles");
    const reconciled = reconcileCaptions({
      asr: recognized.cues,
      duration,
      ...(script === undefined ? {} : { script }),
    });
    if (reconciled.cues.length === 0) throw new CliError("no captions left after clamping to the video duration");
    const stored = roundTime(duration);
    const file: CaptionFile = {
      format: "lumen.captions@1",
      video,
      duration: stored,
      clamped: reconciled.clamped,
      confirmed: reconciled.confirmed,
      script: reconciled.script,
      ...(recognized.duration === undefined ? {} : { asrDuration: roundTime(recognized.duration) }),
      cues: reconciled.cues,
    };
    ctx.response = file;
    ctx.files.push({ path: jsonPath, text: `${JSON.stringify(file, null, 2)}\n` });
    ctx.files.push({ path: txtPath, text: toReadable(file) });
    if (srtPath !== undefined) ctx.files.push({ path: srtPath, text: toSrt(file.cues) });
    if (assPath !== undefined) ctx.files.push({ path: assPath, text: toAss(file.cues) });
    for (const row of summary(file)) line(io, row);
  });
}

async function cuesFromFile(file: string): Promise<{ kind: "json" | "text"; doc: CueDocument; cues: Cue[] }> {
  const text = await readFile(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") {
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new CliError(`${file}: not valid JSON`);
    }
    const doc = readCueDocument(data);
    if (doc.cues.length === 0) throw new CliError(`${file}: no captions`);
    return { kind: "json", doc, cues: doc.cues };
  }
  if (ext === ".srt" || ext === ".vtt") {
    const cues = parseTimedText(text);
    if (cues.length === 0) throw new CliError(`${file}: no captions`);
    return { kind: "text", doc: { cues }, cues };
  }
  if (ext === ".ass" || ext === ".ssa") {
    const cues = parseAss(text);
    if (cues.length === 0) throw new CliError(`${file}: no captions`);
    return { kind: "text", doc: { cues }, cues };
  }
  throw new CliError("captions burn accepts a .json, .srt, or .ass file", 2);
}

function assertConfirmed(kind: "json" | "text", doc: CueDocument, confirm: boolean): void {
  if (confirm || kind === "text") return;
  if (doc.confirmed === true) return;
  if (doc.format?.startsWith("lumen.captions") || doc.confirmed === false) {
    throw new CliError("these captions are not confirmed. Read the transcript, then re-run with --confirm");
  }
}

export async function burnCommand(args: string[], project: string, io: IO): Promise<number> {
  const { values, rest } = parseFlags(args, {
    video: "string",
    subs: "string",
    to: "string",
    position: "string",
    "font-size": "string",
    margin: "string",
    font: "string",
    color: "string",
    background: "string",
    "radius-factor": "string",
    "pad-x": "string",
    "pad-y": "string",
    confirm: "boolean",
    "dry-run": "boolean",
    execute: "boolean",
    json: "boolean",
  });
  requireRestEmpty(rest);
  if (values["dry-run"] === true && values.execute === true) {
    throw new CliError("choose one of --dry-run, --execute", 2);
  }
  const videoFlag = flagString(values, "video");
  const subsFlag = flagString(values, "subs");
  const toFlag = flagString(values, "to");
  if (videoFlag === undefined || videoFlag.trim().length === 0) throw new CliError("captions burn requires --video <file>", 2);
  if (subsFlag === undefined || subsFlag.trim().length === 0) throw new CliError("captions burn requires --subs <file>", 2);
  if (toFlag === undefined || toFlag.trim().length === 0) throw new CliError("captions burn requires --to <file>", 2);
  const video = path.resolve(project, videoFlag.trim());
  const subs = path.resolve(project, subsFlag.trim());
  const output = path.resolve(project, toFlag.trim());
  if (!(await fileExists(video))) throw new CliError(`video not found: ${video}`);
  if (!(await fileExists(subs))) throw new CliError(`subs not found: ${subs}`);
  const loaded = await cuesFromFile(subs);
  assertConfirmed(loaded.kind, loaded.doc, values.confirm === true);
  const fontFlag = flagString(values, "font");
  const fontFile = fontFlag === undefined ? undefined : path.resolve(project, fontFlag);
  if (fontFile !== undefined && !(await fileExists(fontFile))) throw new CliError(`font not found: ${fontFile}`);
  const position = parsePosition(flagString(values, "position"));
  const fontSize = parseFontSize(flagString(values, "font-size"));
  const margin = parseMargin(flagString(values, "margin"));
  const radiusFactor = parseFactor(flagString(values, "radius-factor"), "--radius-factor");
  const padXFactor = parseFactor(flagString(values, "pad-x"), "--pad-x");
  const padYFactor = parseFactor(flagString(values, "pad-y"), "--pad-y");
  const style: BurnStyle = {
    ...(position === undefined ? {} : { position }),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(margin === undefined ? {} : { margin }),
    ...(fontFile === undefined ? {} : { fontFile }),
    color: parseBurnColor(flagString(values, "color"), "--color", TEXT_COLOR),
    background: parseBurnColor(flagString(values, "background"), "--background", BACKGROUND_COLOR),
    ...(radiusFactor === undefined ? {} : { radiusFactor }),
    ...(padXFactor === undefined ? {} : { padXFactor }),
    ...(padYFactor === undefined ? {} : { padYFactor }),
  };
  const config = await loadConfig(project, io.env);
  const note = (name: "ffmpeg" | "ffprobe"): void => {
    io.stderr(`downloading ${name}\n`);
  };
  const ffprobe = await requireBinary("ffprobe", io.env, config.config.tools, true, io.fetch, note);
  const info = await probeVideo(ffprobe.path, video);
  const plan = await resolveBurnPlan(info, loaded.cues, style);
  const report = {
    width: plan.width,
    height: plan.height,
    duration: plan.duration,
    position: plan.position,
    fontSize: plan.fontSize,
    margin: plan.margin,
    fontFile: plan.fontFile,
    cues: plan.cues,
    output,
  };
  if (values["dry-run"] === true) {
    if (values.json === true) line(io, JSON.stringify({ planned: true, ...report }));
    else {
      line(io, `planned: ${output}`);
      line(io, `video: ${plan.width}x${plan.height}`);
      line(io, `position: ${plan.position}`);
      line(io, `fontSize: ${plan.fontSize}`);
      line(io, `margin: ${plan.margin}`);
      line(io, `cues: ${plan.cues}`);
      line(io, `duration: ${plan.duration.toFixed(3)}`);
    }
    return 0;
  }
  if (await fileExists(output)) throw new CliError(`refused to overwrite ${output}`);
  const ffmpeg = await requireBinary("ffmpeg", io.env, config.config.tools, true, io.fetch, note);
  const burned = await burnCaptions({ ffmpeg: ffmpeg.path, video, info, cues: loaded.cues, output, style });
  if (values.json === true) line(io, JSON.stringify({ ...report, fontSize: burned.fontSize, position: burned.position, margin: burned.margin }));
  else {
    line(io, `burned: ${output}`);
    line(io, `video: ${burned.width}x${burned.height}`);
    line(io, `position: ${burned.position}`);
    line(io, `fontSize: ${burned.fontSize}`);
    line(io, `margin: ${burned.margin}`);
    line(io, `cues: ${burned.cues}`);
    line(io, `duration: ${burned.duration.toFixed(3)}`);
  }
  return 0;
}

export async function captionsCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "transcribe") return transcribeCommand(rest, project, io, command);
  if (sub === "burn") return burnCommand(rest, project, io);
  throw new CliError("captions needs transcribe or burn", 2);
}

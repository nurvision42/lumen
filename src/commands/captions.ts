import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAsr, assertAsrLanguage, type AsrOptions } from "../clients/asr.js";
import { burnCaptions, parseBurnColor, probeVideo, resolveBurnPlan, type BurnStyle } from "../captions/burn.js";
import {
  clampCues,
  correctCueTexts,
  cuesFromTask,
  readCueDocument,
  toAss,
  toReadable,
  toSrt,
  type CaptionFile,
  type Cue,
  type CueCorrection,
  type CueDocument,
} from "../captions/cues.js";
import { loadConfig, missingKey } from "../config.js";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { flagString, parseFlags, requireRestEmpty, runMode } from "../flags.js";
import { BITRATE_FALLBACK_NOTE } from "../grain/apply.js";
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
  if (flagString(values, "script") !== undefined) {
    throw new CliError(
      "captions transcribe does not take --script. It keeps the recognition cues and their times. Pass the spoken words to captions burn --speech <text> or --speech-file <file>.",
      2,
    );
  }
  if (values["no-script"] === true) {
    io.stderr("note: --no-script is unnecessary; transcribe does not read a project script\n");
  }
  const language = assertAsrLanguage(flagString(values, "language"));
  const options: AsrOptions = { speaker: values.speaker === true, ...(language === undefined ? {} : { language }) };
  const video = isRemoteMedia(videoFlag.trim()) ? videoFlag.trim() : path.resolve(project, videoFlag.trim());

  return settle(io, project, command, MODEL, mode, async (runId, ctx) => {
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
      script: null,
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
        "script: none",
        `json: ${jsonPath}`,
        `text: ${txtPath}`,
      ]) line(io, row);
      return;
    }
    const recognized = cuesFromTask(outcome.task);
    const duration = probed ?? recognized.duration;
    if (duration === undefined || !(duration > 0)) throw new CliError(`could not read a duration from ${video}`);
    if (recognized.cues.length === 0) throw new CliError("MediaKit ASR returned no subtitles");
    const clamped = clampCues(recognized.cues, duration);
    if (clamped.cues.length === 0) throw new CliError("no captions left after clamping to the video duration");
    const stored = roundTime(duration);
    const file: CaptionFile = {
      format: "lumen.captions@1",
      video,
      duration: stored,
      clamped: clamped.clamped,
      confirmed: false,
      script: null,
      ...(recognized.duration === undefined ? {} : { asrDuration: roundTime(recognized.duration) }),
      cues: clamped.cues,
    };
    ctx.response = file;
    ctx.files.push({ path: jsonPath, text: `${JSON.stringify(file, null, 2)}\n` });
    ctx.files.push({ path: txtPath, text: toReadable(file) });
    if (srtPath !== undefined) ctx.files.push({ path: srtPath, text: toSrt(file.cues) });
    if (assPath !== undefined) ctx.files.push({ path: assPath, text: toAss(file.cues) });
    for (const row of summary(file)) line(io, row);
  });
}

const SPEECH_REQUIRED = "captions burn requires --speech <text> or --speech-file <file> for this video. Pass the spoken words in order, without speaker names. --confirm does not replace that text.";

async function spokenWords(project: string, inline: string | undefined, file: string | undefined): Promise<string> {
  if (inline !== undefined && file !== undefined) throw new CliError("pass either --speech or --speech-file", 2);
  if (inline === undefined && file === undefined) throw new CliError(SPEECH_REQUIRED, 2);
  const raw = inline !== undefined ? inline : await readFile(path.resolve(project, file ?? ""), "utf8");
  const spoken = raw.replace(/^\uFEFF/, "").trim();
  if (spoken.length === 0) throw new CliError("spoken text is empty", 2);
  if (spoken.includes("-->") || spoken.startsWith("{") || spoken.startsWith("[")) {
    throw new CliError("spoken text must be the words only, not an SRT, ASS, or cue JSON. Cue times stay on the recognition file.", 2);
  }
  if (/^\s*\[[^\]]{1,40}\]/m.test(spoken) || /^\s*【[^】]{1,40}】/m.test(spoken)) {
    throw new CliError("spoken text must not include speaker names. Remove labels such as [name] or 【名字】 and keep the words in order.", 2);
  }
  return spoken;
}

function speechSibling(subs: string): { json: string; summary: string } {
  const ext = path.extname(subs);
  const base = ext.length > 0 ? subs.slice(0, -ext.length) : subs;
  return { json: `${base}.speech.json`, summary: `${base}.speech.txt` };
}

function correctionSummary(correction: CueCorrection, source: string): string {
  const lines = [
    `source: ${source}`,
    `speechCoverage: ${correction.speechCoverage.toFixed(3)}`,
    `asrCoverage: ${correction.asrCoverage.toFixed(3)}`,
    `cues: ${correction.cues.length}`,
    "",
  ];
  correction.cues.forEach((cue, index) => {
    const change = correction.changes.find((item) => item.index === index);
    lines.push(`${index + 1} ${cue.start.toFixed(3)}-${cue.end.toFixed(3)}`);
    lines.push(change === undefined ? cue.text : `${change.from} -> ${change.to}`);
    lines.push("");
  });
  return `${lines.join("\n")}`;
}

async function cuesFromFile(file: string): Promise<{ doc: CueDocument; cues: Cue[] }> {
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".json") {
    throw new CliError(
      "captions burn only reads a lumen.captions JSON from transcribe. SRT and ASS are not burned: their times are not checked against recognition. Pass that JSON with --speech or --speech-file.",
      2,
    );
  }
  const text = await readFile(file, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new CliError(`${file}: not valid JSON`);
  }
  const doc = readCueDocument(data);
  if (!doc.format?.startsWith("lumen.captions")) {
    throw new CliError(
      `${file} is not a lumen.captions file. A timed script cannot supply cue times. Run captions transcribe, then pass that JSON with the spoken words.`,
      2,
    );
  }
  if (doc.cues.length === 0) throw new CliError(`${file}: no captions`);
  return { doc, cues: doc.cues };
}

function assertConfirmed(doc: CueDocument, confirm: boolean): void {
  if (confirm || doc.confirmed === true) return;
  throw new CliError("these captions are not confirmed. Read the transcript, then re-run with --confirm. --confirm does not replace --speech.");
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
    speech: "string",
    "speech-file": "string",
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
  const speech = await spokenWords(project, flagString(values, "speech"), flagString(values, "speech-file"));
  if (!(await fileExists(video))) throw new CliError(`video not found: ${video}`);
  if (!(await fileExists(subs))) throw new CliError(`subs not found: ${subs}`);
  const loaded = await cuesFromFile(subs);
  assertConfirmed(loaded.doc, values.confirm === true);
  const correction = correctCueTexts(loaded.cues, speech);
  if (!correction.ok) {
    throw new CliError(`${correction.reasons.join("\n")}\nNo video was written.`);
  }
  const sibling = speechSibling(subs);
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
  const plan = await resolveBurnPlan(info, correction.cues, style);
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
  const bitrateNote = info.bitrate.source === "format" ? BITRATE_FALLBACK_NOTE : undefined;
  if (values["dry-run"] === true) {
    if (values.json === true) line(io, JSON.stringify({ planned: true, ...report }));
    else {
      if (bitrateNote !== undefined) line(io, bitrateNote);
      line(io, `planned: ${output}`);
      line(io, `video: ${plan.width}x${plan.height}`);
      line(io, `position: ${plan.position}`);
      line(io, `fontSize: ${plan.fontSize}`);
      line(io, `margin: ${plan.margin}`);
      line(io, `cues: ${plan.cues}`);
      line(io, `duration: ${plan.duration.toFixed(3)}`);
      line(io, `speech: ${correction.speechCoverage.toFixed(3)}/${correction.asrCoverage.toFixed(3)}`);
    }
    return 0;
  }
  if (await fileExists(output)) throw new CliError(`refused to overwrite ${output}`);
  await refuseExisting([sibling.json, sibling.summary]);
  const ffmpeg = await requireBinary("ffmpeg", io.env, config.config.tools, true, io.fetch, note);
  const burned = await burnCaptions({ ffmpeg: ffmpeg.path, video, info, cues: correction.cues, output, style });
  const correctedFile = {
    format: "lumen.captions@1" as const,
    source: subs,
    confirmed: true,
    speechCoverage: Math.round(correction.speechCoverage * 1000) / 1000,
    asrCoverage: Math.round(correction.asrCoverage * 1000) / 1000,
    cues: correction.cues,
  };
  await writeFile(sibling.json, `${JSON.stringify(correctedFile, null, 2)}\n`, "utf8");
  await writeFile(sibling.summary, correctionSummary(correction, subs), "utf8");
  if (values.json === true) line(io, JSON.stringify({ ...report, fontSize: burned.fontSize, position: burned.position, margin: burned.margin }));
  else {
    if (bitrateNote !== undefined) line(io, bitrateNote);
    line(io, `burned: ${output}`);
    line(io, `video: ${burned.width}x${burned.height}`);
    line(io, `position: ${burned.position}`);
    line(io, `fontSize: ${burned.fontSize}`);
    line(io, `margin: ${burned.margin}`);
    line(io, `cues: ${burned.cues}`);
    line(io, `duration: ${burned.duration.toFixed(3)}`);
    line(io, `speech: ${correction.speechCoverage.toFixed(3)}/${correction.asrCoverage.toFixed(3)}`);
    line(io, `corrected: ${sibling.json}`);
    line(io, `summary: ${sibling.summary}`);
  }
  return 0;
}

export async function captionsCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "transcribe") return transcribeCommand(rest, project, io, command);
  if (sub === "burn") return burnCommand(rest, project, io);
  throw new CliError("captions needs transcribe or burn", 2);
}

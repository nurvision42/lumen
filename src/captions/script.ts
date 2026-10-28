import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { loadShotlist, type Shot } from "../shotlist.js";
import { loadSpans } from "../sprite/shots.js";
import { readCueDocument, parseTimedText, type ScriptLine } from "./cues.js";

export interface ScriptCopy {
  source: "file" | "shotlist" | "voice";
  file: string;
  timed: boolean;
  lines: ScriptLine[];
  text: string;
}

const VOICE_MODELS = new Set(["voice-synthesis", "voice-clone"]);

function shotFlag(command: readonly string[]): number | undefined {
  for (let index = 0; index < command.length; index += 1) {
    const arg = command[index];
    if (arg === "--shot") {
      const next = command[index + 1];
      if (next !== undefined && /^\d+$/.test(next)) return Number(next);
    }
    if (arg?.startsWith("--shot=")) {
      const value = arg.slice("--shot=".length);
      if (/^\d+$/.test(value)) return Number(value);
    }
  }
  return undefined;
}

async function quietShotlist(project: string): Promise<{ file: string; shots: Shot[] } | undefined> {
  try {
    return await loadShotlist(project);
  } catch (error) {
    if (error instanceof CliError) return undefined;
    throw error;
  }
}

interface VoiceLine {
  shot?: number;
  time: string;
  text: string;
  file: string;
}

async function voiceLines(project: string): Promise<VoiceLine[]> {
  const dir = path.join(project, ".lumen", "runs");
  if (!(await fileExists(dir))) return [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const lines: VoiceLine[] = [];
  for (const name of names) {
    const file = path.join(dir, name, "record.json");
    if (!(await fileExists(file))) continue;
    let record: {
      time?: string;
      command?: string[];
      modelId?: string;
      status?: string;
      params?: { text?: unknown };
    };
    try {
      record = JSON.parse(await readFile(file, "utf8")) as typeof record;
    } catch {
      continue;
    }
    if (record.status !== "ok" || record.modelId === undefined || !VOICE_MODELS.has(record.modelId)) continue;
    const text = typeof record.params?.text === "string" ? record.params.text.trim() : "";
    if (text.length === 0) continue;
    const shot = shotFlag(record.command ?? []);
    lines.push({
      time: record.time ?? "",
      text,
      file,
      ...(shot === undefined ? {} : { shot }),
    });
  }
  lines.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return lines;
}

function timedFromShots(shots: readonly Shot[], voice: readonly VoiceLine[]): ScriptLine[] {
  const byShot = new Map<number, string>();
  for (const line of voice) {
    if (line.shot !== undefined) byShot.set(line.shot, line.text);
  }
  let cursor = 0;
  const lines: ScriptLine[] = [];
  for (const shot of shots) {
    const text = shot.vo.trim() || byShot.get(shot["#"]) || "";
    const start = cursor;
    cursor += shot.durationSec;
    if (text.length === 0) continue;
    lines.push({ start, end: cursor, text });
  }
  return lines;
}

/** Shot list voice-over wins. A finished voice-synthesis or voice-clone run fills an empty line. */
export async function discoverScript(project: string): Promise<ScriptCopy | undefined> {
  const shotlist = await quietShotlist(project);
  const voice = await voiceLines(project);
  if (shotlist !== undefined && shotlist.shots.length > 0) {
    const lines = timedFromShots(shotlist.shots, voice);
    if (lines.length > 0) {
      const fromShotlist = shotlist.shots.some((shot) => shot.vo.trim().length > 0);
      return {
        source: fromShotlist ? "shotlist" : "voice",
        file: fromShotlist ? shotlist.file : (voice.find((line) => line.shot !== undefined)?.file ?? shotlist.file),
        timed: true,
        lines,
        text: lines.map((line) => line.text).join("\n"),
      };
    }
  }
  if (voice.length === 0) return undefined;
  const text = voice.map((line) => line.text).join("\n");
  const first = voice[0];
  if (first === undefined) return undefined;
  return {
    source: "voice",
    file: first.file,
    timed: false,
    lines: [{ text }],
    text,
  };
}

export async function loadScriptFile(file: string): Promise<ScriptCopy> {
  if (!(await fileExists(file))) throw new CliError(`script not found: ${file}`);
  const raw = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new CliError(`script is empty: ${file}`);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed) as unknown;
    } catch {
      throw new CliError(`${file}: not valid JSON`);
    }
    const doc = readCueDocument(data);
    if (doc.cues.length > 0) {
      return {
        source: "file",
        file,
        timed: true,
        lines: doc.cues.map((cue) => ({ start: cue.start, end: cue.end, text: cue.text })),
        text: doc.cues.map((cue) => cue.text).join("\n"),
      };
    }
    if (Array.isArray(data) && data.every((item) => typeof item === "string")) {
      const text = data.map((item) => item.trim()).filter((item) => item.length > 0).join("\n");
      if (text.length > 0) return { source: "file", file, timed: false, lines: [{ text }], text };
    }
    throw new CliError(`${file}: no script text`);
  }
  if (trimmed.includes("-->")) {
    const cues = parseTimedText(trimmed);
    if (cues.length > 0) {
      return {
        source: "file",
        file,
        timed: true,
        lines: cues.map((cue) => ({ start: cue.start, end: cue.end, text: cue.text })),
        text: cues.map((cue) => cue.text).join("\n"),
      };
    }
  }
  try {
    const spans = await loadSpans(file);
    const lines = spans.filter((span) => span.text !== undefined && span.text.trim().length > 0);
    if (lines.length > 0) {
      return {
        source: "file",
        file,
        timed: true,
        lines: lines.map((span) => ({ start: span.start, end: span.end, text: span.text?.trim() ?? "" })),
        text: lines.map((span) => span.text?.trim() ?? "").join("\n"),
      };
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
  }
  return { source: "file", file, timed: false, lines: [{ text: trimmed }], text: trimmed };
}

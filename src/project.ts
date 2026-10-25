import { stat } from "node:fs/promises";
import path from "node:path";
import { CliError, errorCode } from "./errors.js";

export const LAYOUT = {
  shotlistMd: "shotlist.md",
  shotlistJson: "shotlist.json",
  refs: "refs",
  shots: "shots",
  out: "out",
  concatFile: "film.mp4",
} as const;

/** Shot folder name: at least two digits (`1` → `01`, `100` → `100`). */
export function shotDirName(n: number): string {
  return String(n).padStart(2, "0");
}

export function resolveProject(cwd: string, project?: string): string {
  return path.resolve(cwd, project ?? ".");
}

export async function assertProject(dir: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new CliError(`not a project folder: ${dir}`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (errorCode(err) === "ENOENT") throw new CliError(`project folder does not exist: ${dir}`);
    throw err;
  }
}

export function outputPath(
  project: string,
  input: { shot?: number; folder: "frame" | "clip" | "vo"; filename: string; out?: string },
): string {
  if (input.out !== undefined) return path.resolve(project, input.out);
  if (input.shot !== undefined) {
    return path.join(project, LAYOUT.shots, shotDirName(input.shot), input.folder, input.filename);
  }
  return path.join(project, LAYOUT.out, input.filename);
}

import { stat } from "node:fs/promises";
import path from "node:path";
import { rejectUnknown } from "../args.js";
import { CliError, errorCode } from "../errors.js";
import { line, type IO } from "../io.js";
import { LAYOUT } from "../project.js";

/** v0 stub. Names ffmpeg and the planned output. Does not invoke ffmpeg. */
export async function concatCommand(args: string[], project: string, io: IO): Promise<number> {
  rejectUnknown(args);
  try {
    const info = await stat(project);
    if (!info.isDirectory()) throw new CliError(`not a project folder: ${project}`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (errorCode(err) === "ENOENT") throw new CliError(`project folder does not exist: ${project}`);
    throw err;
  }

  const output = path.join(project, LAYOUT.out, LAYOUT.concatFile);
  line(io, "[stub] concat");
  line(io, `would read: ${path.join(project, LAYOUT.shots)}/*/clip in ascending shot number`);
  line(io, `would write: ${output}`);
  line(io, "planned tool: ffmpeg");
  line(io, "ffmpeg is not invoked in v0");
  return 0;
}

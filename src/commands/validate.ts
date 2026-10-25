import path from "node:path";
import { rejectUnknown } from "../args.js";
import { CliError } from "../errors.js";
import { line, type IO } from "../io.js";
import { loadShotlist } from "../shotlist.js";

export async function validateCommand(args: string[], project: string, io: IO): Promise<number> {
  rejectUnknown(args);
  const loaded = await loadShotlist(project);
  const name = path.basename(loaded.file);
  if (loaded.shots.length === 0) throw new CliError(`${name}: no shots`);

  const noun = loaded.shots.length === 1 ? "shot" : "shots";
  line(io, `ok ${name} (${loaded.shots.length} ${noun})`);
  for (const shot of loaded.shots) {
    const voice = shot.vo.length > 0 ? "vo" : "no vo";
    line(io, `#${shot["#"]}  ${shot.durationSec}s  ${voice}`);
    line(io, `  frame: ${shot.frame}`);
  }
  return 0;
}

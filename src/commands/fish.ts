import type { FishModel } from "../catalog.js";
import { CliError } from "../errors.js";
import type { IO } from "../io.js";
import { genVoice } from "./gen.js";

const OPS: Record<string, FishModel> = {
  design: "voice-design-1",
  clone: "voice-clone",
  synth: "voice-synthesis",
};

export async function fishCommand(args: string[], project: string, io: IO, command: string[]): Promise<number> {
  const [op, ...rest] = args;
  if (op === undefined || OPS[op] === undefined) throw new CliError("fish needs design, clone, or synth", 2);
  return genVoice(rest, project, io, command, OPS[op]);
}

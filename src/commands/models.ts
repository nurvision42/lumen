import { canonicalModel, MODELS, modelInfo } from "../catalog.js";
import { CliError } from "../errors.js";
import { line, type IO } from "../io.js";

export async function modelsCommand(args: string[], io: IO): Promise<number> {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const flags = args.filter((arg) => arg.startsWith("-"));
  if (flags.length > 0) throw new CliError(`unknown option: ${flags[0]}`, 2);
  if (positional.length > 1) throw new CliError("models accepts at most one model id", 2);
  const id = positional[0] === undefined ? undefined : canonicalModel(positional[0]);
  const listed = id === undefined ? MODELS : MODELS.filter((model) => model.id === id);
  if (id !== undefined && modelInfo(id) === undefined) throw new CliError(`unknown model ${positional[0]}`);
  for (const model of listed) {
    line(io, `${model.id}  ${model.kind}  ${model.providers.join(",")}`);
    line(io, `  ${model.summary}`);
  }
  return 0;
}

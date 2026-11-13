import { CliError } from "./errors.js";

export function extractProject(argv: string[]): { argv: string[]; project?: string; projectSelected: boolean } {
  const rest: string[] = [];
  let project: string | undefined;
  let projectSelected = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--project") {
      const next = argv[i + 1];
      // `breakdown prompt` treats a bare `--project` as the current directory.
      if (next === undefined || next.startsWith("--")) {
        if (!isBreakdownPrompt(argv)) throw new CliError("--project needs a directory", 2);
        projectSelected = true;
        continue;
      }
      project = next;
      projectSelected = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      const value = arg.slice("--project=".length);
      if (value.length === 0) throw new CliError("--project needs a directory", 2);
      project = value;
      projectSelected = true;
      continue;
    }
    rest.push(arg);
  }
  return { argv: rest, project, projectSelected };
}

function isBreakdownPrompt(argv: string[]): boolean {
  const words: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) continue;
    words.push(arg);
    if (words.length >= 2) break;
  }
  return words[0] === "breakdown" && words[1] === "prompt";
}

export function takeOption(args: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === name) {
      if (seen) throw new CliError(`${name} was given twice`, 2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliError(`${name} needs a value`, 2);
      }
      value = next;
      seen = true;
      i += 1;
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      if (seen) throw new CliError(`${name} was given twice`, 2);
      value = arg.slice(name.length + 1);
      if (value.length === 0) throw new CliError(`${name} needs a value`, 2);
      seen = true;
      continue;
    }
    rest.push(arg);
  }
  return { value, rest };
}

export function rejectUnknown(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown !== undefined) throw new CliError(`unknown option: ${unknown}`, 2);
  if (args.length > 0) throw new CliError(`unexpected argument: ${args[0]}`, 2);
}

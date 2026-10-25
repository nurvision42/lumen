import { CliError } from "./errors.js";

export type FlagKind = "string" | "boolean" | "list";

export function parseFlags(
  args: string[],
  spec: Record<string, FlagKind>,
): { values: Record<string, string | boolean | string[] | undefined>; rest: string[] } {
  const values: Record<string, string | boolean | string[] | undefined> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    if (rawName.startsWith("no-")) {
      const base = rawName.slice(3);
      if (spec[base] === "boolean" && inline === undefined) {
        values[base] = false;
        continue;
      }
    }
    const kind = spec[rawName];
    if (kind === undefined) throw new CliError(`unknown option: --${rawName}`, 2);
    if (kind === "boolean") {
      if (inline === undefined || inline === "true") values[rawName] = true;
      else if (inline === "false") values[rawName] = false;
      else throw new CliError(`--${rawName} needs true or false`, 2);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) throw new CliError(`--${rawName} needs a value`, 2);
      value = next;
      i += 1;
    }
    if (value.length === 0) throw new CliError(`--${rawName} needs a value`, 2);
    if (kind === "list") {
      const current = values[rawName];
      const list = Array.isArray(current) ? current : [];
      list.push(value);
      values[rawName] = list;
      continue;
    }
    if (values[rawName] !== undefined) throw new CliError(`--${rawName} was given twice`, 2);
    values[rawName] = value;
  }
  return { values, rest };
}

export type RunMode = "dry-run" | "execute" | "mock";

export function runMode(values: Record<string, string | boolean | string[] | undefined>): RunMode {
  const chosen = (["dry-run", "execute", "mock"] as const).filter((name) => values[name] === true);
  if (chosen.length > 1) throw new CliError(`choose one of --dry-run, --execute, --mock`, 2);
  return chosen[0] ?? "dry-run";
}

export function flagString(
  values: Record<string, string | boolean | string[] | undefined>,
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function flagList(values: Record<string, string | boolean | string[] | undefined>, name: string): string[] {
  const value = values[name];
  return Array.isArray(value) ? value : [];
}

export function requireRestEmpty(rest: string[]): void {
  if (rest.length > 0) throw new CliError(`unexpected argument: ${rest[0]}`, 2);
}

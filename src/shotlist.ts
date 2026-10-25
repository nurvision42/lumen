import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CliError, errorCode } from "./errors.js";
import { fileExists } from "./fsutil.js";
import { LAYOUT } from "./project.js";

/** The only shot fields. Keep schemas/shotlist.schema.json in sync. */
export const SHOT_FIELDS = ["#", "durationSec", "frame", "vo"] as const;

export const shotSchema = z
  .object({
    "#": z.number().int().positive(),
    durationSec: z.number().positive(),
    frame: z.string().min(1),
    vo: z.string(),
  })
  .strict();

export const shotlistSchema = z.array(shotSchema);

export type Shot = z.infer<typeof shotSchema>;

export const SHOTLIST_MD_TEMPLATE = `# shotlist

一行一个镜头。只保留这四列：#、durationSec、frame、vo。
One row per shot. Only these columns: #, durationSec, frame, vo.

| # | durationSec | frame | vo |
|---|-------------|-------|----|
`;

export interface LoadedShotlist {
  file: string;
  shots: Shot[];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const body = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
  return body.split("|").map((cell) => cell.trim());
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function headerKey(cell: string): "#" | "durationSec" | "frame" | "vo" | null {
  if (cell === "#") return "#";
  const lower = cell.toLowerCase();
  if (lower === "durationsec") return "durationSec";
  if (lower === "frame") return "frame";
  if (lower === "vo") return "vo";
  return null;
}

function parseMarkdown(text: string, label: string): { rows: unknown[]; lines: number[] } {
  const lines = stripBom(text).split(/\r?\n/);
  let header: Array<ReturnType<typeof headerKey>> | undefined;
  const rows: unknown[] = [];
  const rowLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const source = lines[i] ?? "";
    const cells = splitRow(source);
    if (cells === null || cells.every((cell) => cell.length === 0)) continue;
    if (isSeparator(cells)) {
      if (header === undefined) {
        throw new CliError(`${label} line ${i + 1}: header must be # | durationSec | frame | vo`);
      }
      continue;
    }
    if (header === undefined) {
      const mapped = cells.map(headerKey);
      if (
        mapped.length !== SHOT_FIELDS.length ||
        mapped.some((key) => key === null) ||
        new Set(mapped).size !== SHOT_FIELDS.length
      ) {
        throw new CliError(`${label}: header must be # | durationSec | frame | vo`);
      }
      header = mapped;
      continue;
    }
    if (cells.length !== header.length) {
      throw new CliError(`${label} line ${i + 1}: expected ${header.length} cells`);
    }
    const record: Record<string, unknown> = {};
    header.forEach((key, index) => {
      if (key === null) return;
      const raw = cells[index] ?? "";
      if (key === "#") {
        if (!/^\d+$/.test(raw)) {
          throw new CliError(`${label} line ${i + 1}: # must be a positive integer`);
        }
        record[key] = Number(raw);
        return;
      }
      if (key === "durationSec") {
        if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
          throw new CliError(`${label} line ${i + 1}: durationSec must be a positive number`);
        }
        record[key] = Number(raw);
        return;
      }
      record[key] = raw;
    });
    rows.push(record);
    rowLines.push(i + 1);
  }

  if (header === undefined) return { rows: [], lines: [] };
  return { rows, lines: rowLines };
}

function formatIssue(issue: { path: readonly PropertyKey[]; message: string }): string {
  const field = issue.path.map(String).join(".");
  return field.length > 0 ? `${field}: ${issue.message}` : issue.message;
}

/**
 * Check a JSON-shaped shot list. Empty arrays are returned; `validate` rejects them.
 * Shot numbers must be unique. Unknown fields are rejected.
 */
export function parseShotlistData(
  data: unknown,
  label = "shotlist",
  locate: (index: number) => string = (index) => `${label} [${index}]`,
): Shot[] {
  if (!Array.isArray(data)) throw new CliError(`${label}: must be an array`);

  const shots: Shot[] = [];
  const seen = new Set<number>();
  data.forEach((item, index) => {
    const where = locate(index);
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new CliError(`${where}: shot must be an object`);
    }
    const record = item as Record<string, unknown>;
    const extra = Object.keys(record).filter((key) => !(SHOT_FIELDS as readonly string[]).includes(key));
    if (extra.length > 0) throw new CliError(`${where}: unknown field ${extra.join(", ")}`);
    for (const key of SHOT_FIELDS) {
      if (!(key in record)) throw new CliError(`${where}: missing ${key}`);
    }

    const shotNumber = record["#"];
    const duration = record.durationSec;
    const frame = record.frame;
    const vo = record.vo;
    if (typeof shotNumber !== "number" || !Number.isInteger(shotNumber) || shotNumber < 1) {
      throw new CliError(`${where}: # must be a positive integer`);
    }
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      throw new CliError(`${where}: durationSec must be a positive number`);
    }
    if (typeof frame !== "string" || frame.trim().length === 0) {
      throw new CliError(`${where}: frame must be a non-empty string`);
    }
    if (typeof vo !== "string") throw new CliError(`${where}: vo must be a string`);

    const shot = {
      "#": shotNumber,
      durationSec: duration,
      frame: frame.trim(),
      vo: vo.trim(),
    };
    const checked = shotSchema.safeParse(shot);
    if (!checked.success) {
      throw new CliError(`${where}: ${checked.error.issues.map(formatIssue).join("; ")}`);
    }
    if (seen.has(shot["#"])) throw new CliError(`${label}: duplicate shot #${shot["#"]}`);
    seen.add(shot["#"]);
    shots.push(checked.data);
  });

  return shots;
}

async function assertProjectDir(dir: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new CliError(`not a project folder: ${dir}`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (errorCode(err) === "ENOENT") throw new CliError(`project folder does not exist: ${dir}`);
    throw err;
  }
}

export async function loadShotlist(dir: string): Promise<LoadedShotlist> {
  await assertProjectDir(dir);
  const md = path.join(dir, LAYOUT.shotlistMd);
  const json = path.join(dir, LAYOUT.shotlistJson);
  const [hasMd, hasJson] = await Promise.all([fileExists(md), fileExists(json)]);
  if (hasMd && hasJson) {
    throw new CliError("found both shotlist.md and shotlist.json; keep one");
  }
  if (!hasMd && !hasJson) {
    throw new CliError(
      [
        `no shotlist in ${dir}`,
        "looked for shotlist.md and shotlist.json",
        `run: lumen init ${dir}`,
      ].join("\n"),
    );
  }

  if (hasJson) {
    let data: unknown;
    try {
      data = JSON.parse(stripBom(await readFile(json, "utf8"))) as unknown;
    } catch (err) {
      if (err instanceof SyntaxError) throw new CliError("shotlist.json: not valid JSON");
      throw err;
    }
    return { file: json, shots: parseShotlistData(data, "shotlist.json") };
  }

  const text = await readFile(md, "utf8");
  const parsed = parseMarkdown(text, "shotlist.md");
  const shots = parseShotlistData(parsed.rows, "shotlist.md", (index) => {
    const lineNo = parsed.lines[index];
    return lineNo === undefined ? `shotlist.md [${index}]` : `shotlist.md line ${lineNo}`;
  });
  return { file: md, shots };
}

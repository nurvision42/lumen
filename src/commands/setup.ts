import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { TIKHUB_CREDENTIAL, writeTikhubKey } from "../credentials.js";
import { flagString, parseFlags } from "../flags.js";
import { fail, line, type IO } from "../io.js";
import { binaryLine, requireBinary } from "../tools/resolve.js";

const SETUP_KEYS = ["tikhub"] as const;

/** Read one secret. Injected `readLine` is used in tests. A terminal does not echo. */
async function readSecret(io: IO): Promise<string> {
  if (io.readLine !== undefined) return (await io.readLine()).trim();
  const stdin = process.stdin;
  if (!stdin.isTTY || stdin.setRawMode === undefined) {
    throw new CliError("lumen setup --key tikhub needs a terminal, or set TIKHUB_API_KEY");
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let text = "";
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          cleanup();
          reject(new CliError("setup cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          fail(io, "");
          resolve(text.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          text = text.slice(0, -1);
          continue;
        }
        text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function setupFfmpeg(project: string, io: IO): Promise<number> {
  const loaded = await loadConfig(project, io.env);
  const note = (name: "ffmpeg" | "ffprobe"): void => {
    fail(io, `downloading ${name}`);
  };
  const ffmpeg = await requireBinary("ffmpeg", io.env, loaded.config.tools, true, io.fetch, note);
  const ffprobe = await requireBinary("ffprobe", io.env, loaded.config.tools, true, io.fetch, note);
  line(io, binaryLine("ffmpeg", ffmpeg));
  line(io, binaryLine("ffprobe", ffprobe));
  return 0;
}

export async function setupCommand(args: string[], project: string, io: IO): Promise<number> {
  const { values, rest } = parseFlags(args, { key: "string" });
  if (rest[0] === "ffmpeg") {
    if (rest.length !== 1 || flagString(values, "key") !== undefined) {
      throw new CliError("lumen setup ffmpeg does not take a key or extra arguments", 2);
    }
    return setupFfmpeg(project, io);
  }
  if (rest.length > 0) {
    throw new CliError("lumen setup does not take a key on the command line; run `lumen setup --key tikhub`", 2);
  }
  const key = flagString(values, "key");
  if (key === undefined) throw new CliError("lumen setup needs --key tikhub", 2);
  if (!(SETUP_KEYS as readonly string[]).includes(key)) throw new CliError(`unknown setup key ${key}`, 2);
  fail(io, "TikHub API key:");
  const secret = await readSecret(io);
  await writeTikhubKey(io.env, secret);
  line(io, `saved ${TIKHUB_CREDENTIAL}`);
  line(io, "The key is in the machine credential store. It was not printed or written into the project.");
  return 0;
}

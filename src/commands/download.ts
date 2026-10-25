import path from "node:path";
import { readTikhubKey } from "../credentials.js";
import { downloadDouyinVideo, isDouyinUrl } from "../download/douyin.js";
import { CliError } from "../errors.js";
import { flagString, parseFlags } from "../flags.js";
import { line, type IO } from "../io.js";

const MISSING_KEY = "download needs a TikHub lookup key; run `lumen setup --key tikhub` or set TIKHUB_API_KEY";

export async function downloadCommand(args: string[], project: string, io: IO): Promise<number> {
  const { values, rest } = parseFlags(args, {
    to: "string",
    region: "string",
    json: "boolean",
  });
  if (rest.length !== 1) throw new CliError("download takes exactly one Douyin link", 2);
  const url = rest[0] ?? "";
  if (!isDouyinUrl(url)) {
    throw new CliError("download supports douyin.com links only; this tool does not bundle a general-site downloader");
  }
  const to = flagString(values, "to");
  if (to === undefined || to.trim().length === 0) throw new CliError("download requires --to <path>", 2);
  const apiKey = await readTikhubKey(io.env);
  if (apiKey === undefined) throw new CliError(MISSING_KEY);
  const target = path.resolve(project, to.trim());
  const region = flagString(values, "region");
  const info = await downloadDouyinVideo(url, target, {
    apiKey,
    ...(region === undefined ? {} : { region }),
    ...(io.fetch === undefined ? {} : { fetchImpl: io.fetch }),
  });
  if (values.json === true) {
    line(io, JSON.stringify({
      format: "lumen.cli-download@1",
      path: target,
      url,
      ...(info.videoId === undefined ? {} : { videoId: info.videoId }),
      contentType: info.contentType,
      fileSize: info.fileSize,
    }, null, 2));
    return 0;
  }
  line(io, `已保存到 ${target}`);
  return 0;
}

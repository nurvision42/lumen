import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliError } from "../errors.js";

export type DouyinDownloadInfo = {
  readonly videoId?: string;
  readonly contentType: string;
  readonly fileSize: number;
  readonly originalVideoUrl: string;
};

const API_URL = "https://api.tikhub.io/api/v1/douyin/web/fetch_video_high_quality_play_url";

export function isDouyinUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:")
      && /(^|\.)douyin\.com$/iu.test(url.hostname);
  } catch {
    return false;
  }
}

function detail(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (value === undefined || value === null) return undefined;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : text.slice(0, 500);
  } catch {
    return String(value);
  }
}

function apiError(status: number, body: string): CliError {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown; message_zh?: unknown };
    const message = detail(parsed.detail) ?? detail(parsed.message_zh) ?? detail(parsed.message);
    return new CliError(`TikHub API returned HTTP ${status}: ${message ?? body.slice(0, 500)}`);
  } catch {
    return new CliError(`TikHub API returned HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

async function fetchInfo(
  url: string,
  apiKey: string,
  region: string,
  fetchImpl: FetchImpl,
): Promise<DouyinDownloadInfo> {
  const endpoint = new URL(API_URL);
  endpoint.searchParams.set("share_url", url);
  if (region) endpoint.searchParams.set("region", region);
  const response = await fetchImpl(endpoint.toString(), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const body = await response.text();
  if (!response.ok) throw apiError(response.status, body);
  let payload: { code?: number; message?: string; message_zh?: string; data?: unknown };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    throw new CliError("TikHub API returned invalid JSON");
  }
  if (payload.code !== 200) {
    throw new CliError(`TikHub API error ${payload.code ?? "unknown"}: ${payload.message_zh ?? payload.message ?? "unknown error"}`);
  }
  const data = typeof payload.data === "string"
    ? JSON.parse(payload.data) as Record<string, unknown>
    : payload.data as Record<string, unknown> | undefined;
  const originalVideoUrl = typeof data?.original_video_url === "string" ? data.original_video_url : undefined;
  if (originalVideoUrl === undefined) {
    throw new CliError("TikHub did not return an original video URL; the post may be private, deleted or region restricted");
  }
  const rawSize = Number(data?.file_size ?? 0);
  const videoId = typeof data?.video_id === "string" ? data.video_id : undefined;
  return {
    ...(videoId === undefined ? {} : { videoId }),
    contentType: typeof data?.content_type === "string" ? data.content_type : "video/mp4",
    fileSize: Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0,
    originalVideoUrl,
  };
}

export async function downloadDouyinVideo(
  url: string,
  target: string,
  options: {
    readonly apiKey: string;
    readonly region?: string;
    readonly signal?: AbortSignal;
    readonly fetchImpl?: FetchImpl;
  },
): Promise<DouyinDownloadInfo> {
  if (!isDouyinUrl(url)) throw new CliError("only douyin.com links are supported");
  if (options.apiKey.trim() === "") throw new CliError("TikHub API key is required");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const info = await fetchInfo(url, options.apiKey.trim(), options.region ?? "CN", fetchImpl);
  await mkdir(dirname(target), { recursive: true });
  const response = await fetchImpl(info.originalVideoUrl, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    headers: { "User-Agent": "lumen-douyin-downloader/1.0" },
  });
  if (!response.ok || response.body === null) throw apiError(response.status, await response.text());
  const file = createWriteStream(target, { flags: "wx" });
  try {
    await pipeline(Readable.fromWeb(response.body), file);
  } catch (error) {
    file.destroy();
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(`download refused to overwrite ${target}`);
    }
    await rm(target, { force: true });
    throw error;
  }
  const savedSize = (await stat(target)).size;
  if (info.fileSize > 0 && savedSize !== info.fileSize) {
    await rm(target, { force: true });
    throw new CliError(`download size mismatch: ${savedSize} bytes written, TikHub reported ${info.fileSize}`);
  }
  return { ...info, fileSize: savedSize };
}

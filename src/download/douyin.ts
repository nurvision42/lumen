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

const ORIGINAL_QUALITY_ENDPOINTS = [
  {
    name: "app",
    url: "https://api.tikhub.io/api/v1/douyin/app/v3/fetch_video_high_quality_play_url",
  },
  {
    name: "web",
    url: "https://api.tikhub.io/api/v1/douyin/web/fetch_video_high_quality_play_url",
  },
] as const;

type OriginalQualityEndpoint = (typeof ORIGINAL_QUALITY_ENDPOINTS)[number];

export function isDouyinUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:")
      && /(^|\.)douyin\.com$/iu.test(url.hostname);
  } catch {
    return false;
  }
}

/** Work id from `/video/<id>`, `/note/<id>`, `/share/video/<id>`, `modal_id`, or `aweme_id`. */
export function awemeIdFromUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  const fromPath = url.pathname.match(/\/(?:share\/video|video|note)\/(\d+)/u);
  if (fromPath?.[1] !== undefined) return fromPath[1];
  for (const key of ["modal_id", "aweme_id"]) {
    const query = url.searchParams.get(key);
    if (query !== null && /^\d+$/u.test(query)) return query;
  }
  return undefined;
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

function lookupUrl(endpoint: string, shareUrl: string, region: string | undefined): URL {
  const target = new URL(endpoint);
  const awemeId = awemeIdFromUrl(shareUrl);
  if (awemeId === undefined) target.searchParams.set("share_url", shareUrl);
  else target.searchParams.set("aweme_id", awemeId);
  const regionCode = region?.trim();
  if (regionCode !== undefined && regionCode.length > 0) target.searchParams.set("region", regionCode);
  return target;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      throw new CliError("TikHub API returned invalid JSON");
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function readInfo(body: string): DouyinDownloadInfo {
  let payload: { code?: number; message?: string; message_zh?: string; data?: unknown };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    throw new CliError("TikHub API returned invalid JSON");
  }
  if (payload.code !== 200) {
    throw new CliError(`TikHub API error ${payload.code ?? "unknown"}: ${payload.message_zh ?? payload.message ?? "unknown error"}`);
  }
  const data = asRecord(payload.data);
  const rawUrl = data?.original_video_url;
  const originalVideoUrl = typeof rawUrl === "string" && rawUrl.trim().length > 0 ? rawUrl : undefined;
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

function failureText(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return String(error);
}

async function fetchInfo(
  url: string,
  apiKey: string,
  region: string | undefined,
  fetchImpl: FetchImpl,
): Promise<{ info: DouyinDownloadInfo; endpoint: OriginalQualityEndpoint }> {
  const failures: string[] = [];
  for (const endpoint of ORIGINAL_QUALITY_ENDPOINTS) {
    try {
      const response = await fetchImpl(lookupUrl(endpoint.url, url, region).toString(), {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      const body = await response.text();
      if (!response.ok) throw apiError(response.status, body);
      return { info: readInfo(body), endpoint };
    } catch (error) {
      failures.push(`${endpoint.name}: ${failureText(error)}`);
    }
  }
  throw new CliError(`TikHub original-quality lookup failed. ${failures.join("; ")}`);
}

export async function downloadDouyinVideo(
  url: string,
  target: string,
  options: {
    readonly apiKey: string;
    readonly region?: string;
    readonly signal?: AbortSignal;
    readonly fetchImpl?: FetchImpl;
    readonly log?: (message: string) => void;
  },
): Promise<DouyinDownloadInfo> {
  if (!isDouyinUrl(url)) throw new CliError("only douyin.com links are supported");
  if (options.apiKey.trim() === "") throw new CliError("TikHub API key is required");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const found = await fetchInfo(url, options.apiKey.trim(), options.region, fetchImpl);
  const info = found.info;
  const log = options.log ?? ((message: string) => {
    process.stderr.write(`${message}\n`);
  });
  log(`TikHub original-quality endpoint succeeded: ${found.endpoint.name} ${new URL(found.endpoint.url).pathname}`);
  await mkdir(dirname(target), { recursive: true });
  const response = await fetchImpl(info.originalVideoUrl, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    headers: {
      "User-Agent": "lumen-douyin-downloader/1.0",
      Referer: "https://www.douyin.com/",
    },
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

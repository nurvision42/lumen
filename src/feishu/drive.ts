import { createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliError } from "../errors.js";
import { fileExists } from "../fsutil.js";
import { fetchOf } from "../http.js";
import { resourceUrl, type FeishuBrand } from "./endpoints.js";
import { apiJson, asObject, dataOf, numberField, oauthError, stringField, type ApiClient, type MultipartField } from "./http.js";

export const DEFAULT_SIMPLE_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface DriveItem {
  name: string;
  type: string;
  token: string;
  url: string;
}

const SEARCH_TYPES = ["doc", "sheet", "slides", "bitable", "mindnote", "file"] as const;

export async function searchDrive(
  client: ApiClient,
  brand: FeishuBrand,
  keyword: string,
  options: { type?: string; count?: number; offset?: number } = {},
): Promise<{ items: DriveItem[]; hasMore: boolean; total: number }> {
  const count = options.count ?? 20;
  const offset = options.offset ?? 0;
  const types = options.type === undefined || options.type.length === 0 ? [...SEARCH_TYPES] : [options.type];
  const record = await apiJson(client, "POST", "/suite/docs-api/search/object", {
    json: { search_key: keyword, count, offset, docs_types: types },
  });
  const data = dataOf(record);
  const entities = Array.isArray(data.docs_entities) ? data.docs_entities : [];
  const found = entities.map((item) => {
    const row = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      name: stringField(row, "title"),
      type: stringField(row, "docs_type"),
      token: stringField(row, "docs_token"),
    };
  }).filter((item) => item.token.length > 0);
  const urls = await lookupUrls(client, found.map((item) => ({ token: item.token, type: item.type })));
  return {
    items: found.map((item) => ({
      name: item.name,
      type: item.type,
      token: item.token,
      url: urls.get(item.token) ?? resourceUrl(brand, item.type, item.token),
    })),
    hasMore: data.has_more === true,
    total: numberField(data, "total", found.length),
  };
}

async function lookupUrls(client: ApiClient, docs: Array<{ token: string; type: string }>): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (docs.length === 0) return urls;
  try {
    const record = await apiJson(client, "POST", "/drive/v1/metas/batch_query", {
      json: {
        request_docs: docs.map((item) => ({ doc_token: item.token, doc_type: item.type || "docx" })),
        with_url: true,
      },
    });
    const metas = dataOf(record).metas;
    if (!Array.isArray(metas)) return urls;
    for (const meta of metas) {
      if (meta === null || typeof meta !== "object") continue;
      const row = meta as Record<string, unknown>;
      const token = stringField(row, "doc_token");
      const url = stringField(row, "url");
      if (token.length > 0 && url.length > 0) urls.set(token, url);
    }
  } catch {
    // Search still returns a constructed link when metadata is unavailable.
  }
  return urls;
}

export async function rootFolderToken(client: ApiClient): Promise<string> {
  const record = await apiJson(client, "GET", "/drive/explorer/v2/root_folder/meta");
  const token = stringField(dataOf(record), "token");
  if (token.length === 0) throw new CliError("Feishu did not return the root folder token");
  return token;
}

export async function listFolder(
  client: ApiClient,
  brand: FeishuBrand,
  folderToken: string | undefined,
  options: { pageSize?: number; pageToken?: string } = {},
): Promise<{ items: DriveItem[]; hasMore: boolean; pageToken?: string; folderToken: string }> {
  const folder = folderToken === undefined || folderToken.length === 0 || folderToken === "root" ? await rootFolderToken(client) : folderToken;
  const record = await apiJson(client, "GET", "/drive/v1/files", {
    query: {
      folder_token: folder,
      page_size: String(options.pageSize ?? 50),
      page_token: options.pageToken,
    },
  });
  const data = dataOf(record);
  const files = Array.isArray(data.files) ? data.files : [];
  const items = files.map((item) => {
    const row = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const type = stringField(row, "type");
    const token = stringField(row, "token");
    const url = stringField(row, "url");
    return { name: stringField(row, "name"), type, token, url: url.length > 0 ? url : resourceUrl(brand, type, token) };
  });
  const next = stringField(data, "next_page_token") || stringField(data, "page_token");
  return {
    items,
    hasMore: data.has_more === true,
    folderToken: folder,
    ...(next.length > 0 ? { pageToken: next } : {}),
  };
}

export function chunkPlan(size: number, blockSize: number): Array<{ seq: number; start: number; end: number }> {
  if (!Number.isInteger(blockSize) || blockSize < 1) throw new CliError("Feishu upload returned an invalid block size");
  const parts: Array<{ seq: number; start: number; end: number }> = [];
  let seq = 0;
  for (let start = 0; start < size; start += blockSize) {
    parts.push({ seq, start, end: Math.min(start + blockSize, size) });
    seq += 1;
  }
  if (parts.length === 0) parts.push({ seq: 0, start: 0, end: 0 });
  return parts;
}

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const length = end - start;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function uploadDriveFile(
  client: ApiClient,
  filePath: string,
  options: { folderToken?: string; name?: string; simpleLimit?: number },
): Promise<{ token: string; name: string }> {
  const info = await stat(filePath);
  const name = options.name ?? filePath.split(/[/\\]/).pop() ?? "file";
  const folder = options.folderToken === undefined || options.folderToken.length === 0 ? await rootFolderToken(client) : options.folderToken;
  const limit = options.simpleLimit ?? DEFAULT_SIMPLE_UPLOAD_BYTES;
  if (info.size <= limit) {
    const record = await apiJson(client, "POST", "/drive/v1/files/upload_all", {
      multipart: fileFields(name, "explorer", folder, info.size, await readRange(filePath, 0, info.size)),
    });
    return { token: fileToken(dataOf(record)), name };
  }
  const prepared = dataOf(await apiJson(client, "POST", "/drive/v1/files/upload_prepare", {
    json: { file_name: name, parent_type: "explorer", parent_node: folder, size: info.size },
  }));
  const uploadId = stringField(prepared, "upload_id");
  if (uploadId.length === 0) throw new CliError("Feishu upload did not return an upload id");
  const blockSize = numberField(prepared, "block_size", 4 * 1024 * 1024);
  const parts = chunkPlan(info.size, blockSize);
  for (const part of parts) {
    const bytes = await readRange(filePath, part.start, part.end);
    await apiJson(client, "POST", "/drive/v1/files/upload_part", {
      multipart: [
        { name: "upload_id", value: uploadId },
        { name: "seq", value: String(part.seq) },
        { name: "size", value: String(bytes.byteLength) },
        { name: "file", filename: name, data: bytes },
      ],
    });
  }
  const finished = dataOf(await apiJson(client, "POST", "/drive/v1/files/upload_finish", {
    json: { upload_id: uploadId, block_num: parts.length },
  }));
  return { token: fileToken(finished), name };
}

export async function uploadBitableMedia(
  client: ApiClient,
  appToken: string,
  filePath: string,
  options: { name?: string; simpleLimit?: number } = {},
): Promise<{ fileToken: string; name: string }> {
  const info = await stat(filePath);
  const name = options.name ?? filePath.split(/[/\\]/).pop() ?? "file";
  const extra = JSON.stringify({ drive_route_token: appToken });
  const limit = options.simpleLimit ?? DEFAULT_SIMPLE_UPLOAD_BYTES;
  if (info.size <= limit) {
    const record = await apiJson(client, "POST", "/drive/v1/medias/upload_all", {
      multipart: [...fileFields(name, "bitable_file", appToken, info.size, await readRange(filePath, 0, info.size)), { name: "extra", value: extra }],
    });
    return { fileToken: fileToken(dataOf(record)), name };
  }
  const prepared = dataOf(await apiJson(client, "POST", "/drive/v1/medias/upload_prepare", {
    json: { file_name: name, parent_type: "bitable_file", parent_node: appToken, size: info.size, extra },
  }));
  const uploadId = stringField(prepared, "upload_id");
  if (uploadId.length === 0) throw new CliError("Feishu media upload did not return an upload id");
  const blockSize = numberField(prepared, "block_size", 4 * 1024 * 1024);
  const parts = chunkPlan(info.size, blockSize);
  for (const part of parts) {
    const bytes = await readRange(filePath, part.start, part.end);
    await apiJson(client, "POST", "/drive/v1/medias/upload_part", {
      multipart: [
        { name: "upload_id", value: uploadId },
        { name: "seq", value: String(part.seq) },
        { name: "size", value: String(bytes.byteLength) },
        { name: "file", filename: name, data: bytes },
      ],
    });
  }
  const finished = dataOf(await apiJson(client, "POST", "/drive/v1/medias/upload_finish", {
    json: { upload_id: uploadId, block_num: parts.length },
  }));
  return { fileToken: fileToken(finished), name };
}

function fileFields(name: string, parentType: string, parentNode: string, size: number, data: Buffer): MultipartField[] {
  return [
    { name: "file_name", value: name },
    { name: "parent_type", value: parentType },
    { name: "parent_node", value: parentNode },
    { name: "size", value: String(size) },
    { name: "file", filename: name, data },
  ];
}

function fileToken(data: Record<string, unknown>): string {
  const token = stringField(data, "file_token") || stringField(data, "token");
  if (token.length === 0) throw new CliError("Feishu upload did not return a file token");
  return token;
}

export async function downloadDriveFile(client: ApiClient, token: string, dest: string): Promise<{ path: string; bytes: number }> {
  if (await fileExists(dest)) throw new CliError(`refusing to overwrite ${dest}`);
  const url = new URL(`${client.openBase}/open-apis/drive/v1/files/${encodeURIComponent(token)}/download`);
  const response = await fetchOf(client.io)(url.toString(), { headers: { authorization: `Bearer ${client.token}` } });
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json") || response.status >= 400) {
    const text = await response.text();
    let message = `HTTP ${response.status}`;
    try {
      const record = asObject(JSON.parse(text) as unknown);
      message = stringField(record, "msg") || oauthError(record) || message;
    } catch {
      if (text.trim().length > 0) message = text.trim().slice(0, 300);
    }
    throw new CliError(`Feishu API /drive/v1/files/download failed: ${message}`);
  }
  if (response.body === null) throw new CliError("Feishu download returned an empty body");
  await mkdir(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
  const info = await stat(dest);
  return { path: dest, bytes: info.size };
}

export async function createFolder(client: ApiClient, name: string, folderToken: string | undefined): Promise<{ token: string; url: string; name: string }> {
  const parent = folderToken === undefined || folderToken.length === 0 ? await rootFolderToken(client) : folderToken;
  const data = dataOf(await apiJson(client, "POST", "/drive/v1/files/create_folder", { json: { name, folder_token: parent } }));
  const token = stringField(data, "token");
  if (token.length === 0) throw new CliError("Feishu did not return the new folder token");
  return { token, url: stringField(data, "url"), name: stringField(data, "name") || name };
}

export async function moveItem(client: ApiClient, token: string, type: string, folderToken: string): Promise<Record<string, unknown>> {
  return apiJson(client, "POST", `/drive/v1/files/${encodeURIComponent(token)}/move`, {
    json: { type, folder_token: folderToken },
  });
}

export async function deleteItem(client: ApiClient, token: string, type: string): Promise<Record<string, unknown>> {
  return apiJson(client, "DELETE", `/drive/v1/files/${encodeURIComponent(token)}`, { query: { type } });
}

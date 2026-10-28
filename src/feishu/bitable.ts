import { CliError } from "../errors.js";
import { uploadBitableMedia } from "./drive.js";
import { apiJson, dataOf, stringField, type ApiClient } from "./http.js";

export function normalizeField(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.link_record_ids)) return { linkRecordIds: record.link_record_ids };
  }
  return value;
}

export function normalizeFields(fields: unknown): Record<string, unknown> {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = normalizeField(value);
  return out;
}

/** Link fields are written as record-id arrays. */
export function denormalizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const ids = record.linkRecordIds ?? record.link_record_ids;
      const keys = Object.keys(record);
      if (Array.isArray(ids) && keys.every((name) => name === "linkRecordIds" || name === "link_record_ids")) {
        out[key] = ids;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function itemsOf(data: Record<string, unknown>): unknown[] {
  return Array.isArray(data.items) ? data.items : [];
}

export async function listTables(client: ApiClient, appToken: string, pageToken?: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, {
    query: { page_size: "100", page_token: pageToken },
  }));
  return { items: itemsOf(data), hasMore: data.has_more === true, ...(stringField(data, "page_token").length > 0 ? { pageToken: stringField(data, "page_token") } : {}) };
}

export async function listFields(client: ApiClient, appToken: string, tableId: string, pageToken?: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`, {
    query: { page_size: "100", page_token: pageToken },
  }));
  return { items: itemsOf(data), hasMore: data.has_more === true, ...(stringField(data, "page_token").length > 0 ? { pageToken: stringField(data, "page_token") } : {}) };
}

export async function searchRecords(
  client: ApiClient,
  appToken: string,
  tableId: string,
  options: { filter?: unknown; pageSize?: number; pageToken?: string } = {},
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (options.filter !== undefined) body.filter = options.filter;
  const data = dataOf(await apiJson(client, "POST", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search`, {
    query: { page_size: String(options.pageSize ?? 100), page_token: options.pageToken },
    json: body,
  }));
  const items = itemsOf(data).map((item) => {
    const row = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return { recordId: stringField(row, "record_id"), fields: normalizeFields(row.fields) };
  });
  const next = stringField(data, "page_token");
  return { items, hasMore: data.has_more === true, ...(next.length > 0 ? { pageToken: next } : {}) };
}

export async function createRecord(client: ApiClient, appToken: string, tableId: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "POST", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`, {
    json: { fields: denormalizeFields(fields) },
  }));
  const record = data.record !== null && typeof data.record === "object" ? (data.record as Record<string, unknown>) : data;
  return { recordId: stringField(record, "record_id") || stringField(data, "record_id"), fields: normalizeFields(record.fields ?? fields) };
}

export async function updateRecord(
  client: ApiClient,
  appToken: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "PUT", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`, {
    json: { fields: denormalizeFields(fields) },
  }));
  const record = data.record !== null && typeof data.record === "object" ? (data.record as Record<string, unknown>) : data;
  return { recordId, fields: normalizeFields(record.fields ?? fields) };
}

export async function getRecord(client: ApiClient, appToken: string, tableId: string, recordId: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`));
  const record = data.record !== null && typeof data.record === "object" ? (data.record as Record<string, unknown>) : data;
  return { recordId, fields: record.fields !== null && typeof record.fields === "object" && !Array.isArray(record.fields) ? (record.fields as Record<string, unknown>) : {} };
}

export async function attachFile(
  client: ApiClient,
  appToken: string,
  tableId: string,
  recordId: string,
  field: string,
  filePath: string,
  simpleLimit?: number,
): Promise<Record<string, unknown>> {
  const uploaded = await uploadBitableMedia(client, appToken, filePath, { ...(simpleLimit === undefined ? {} : { simpleLimit }) });
  const current = await getRecord(client, appToken, tableId, recordId);
  const currentFields = current.fields;
  const fields = currentFields !== null && typeof currentFields === "object" && !Array.isArray(currentFields) ? currentFields as Record<string, unknown> : {};
  const existing = fields[field];
  const files = Array.isArray(existing) ? existing.filter((item) => item !== null && typeof item === "object") : [];
  const next = [...files.map((item) => ({ file_token: stringField(item as Record<string, unknown>, "file_token") })).filter((item) => item.file_token.length > 0), { file_token: uploaded.fileToken }];
  const updated = await updateRecord(client, appToken, tableId, recordId, { [field]: next });
  return { ...updated, fileToken: uploaded.fileToken, name: uploaded.name };
}

export function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CliError(`${label} is not valid JSON`, 2);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${label} must be a JSON object`, 2);
  return value as Record<string, unknown>;
}

export function parseJsonValue(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(`${label} is not valid JSON`, 2);
  }
}

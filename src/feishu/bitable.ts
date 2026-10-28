import { CliError } from "../errors.js";
import { resourceUrl, type FeishuBrand } from "./endpoints.js";
import { uploadBitableMedia } from "./drive.js";
import { apiJson, asObject, dataOf, stringField, type ApiClient } from "./http.js";

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

const FIELD_TYPES: Record<string, number> = {
  text: 1,
  multiline: 1,
  文本: 1,
  number: 2,
  数字: 2,
  select: 3,
  "single-select": 3,
  "single_select": 3,
  单选: 3,
  attachment: 17,
  附件: 17,
  link: 18,
  "single-link": 18,
  "one-way": 18,
  "one-way-link": 18,
  单向关联: 18,
  duplex: 21,
  "duplex-link": 21,
  "two-way": 21,
  "two-way-link": 21,
  双向关联: 21,
};

const VIEW_TYPES = new Set(["grid", "kanban", "gallery", "gantt", "form"]);

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fieldTypeOf(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (/^[1-9]\d*$/.test(text)) return Number(text);
    const mapped = FIELD_TYPES[text] ?? FIELD_TYPES[text.toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  throw new CliError(`${label} type must be text, select, number, attachment, link, or duplex`, 2);
}

function optionList(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) throw new CliError(`${label} needs at least one option`, 2);
  return value.map((item, index) => {
    const where = `${label} option ${index + 1}`;
    if (typeof item === "string") {
      const name = item.trim();
      if (name.length === 0) throw new CliError(`${where} is empty`, 2);
      return { name };
    }
    const record = asObject(item);
    const name = textOf(record?.name);
    if (record === undefined || name.length === 0) throw new CliError(`${where} needs a name`, 2);
    const option: Record<string, unknown> = { name };
    if (record.color !== undefined) {
      const color = record.color;
      if (typeof color !== "number" || !Number.isInteger(color) || color < 0 || color > 54) {
        throw new CliError(`${where} color must be an integer from 0 to 54`, 2);
      }
      option.color = color;
    }
    const id = textOf(record.id);
    if (id.length > 0) option.id = id;
    return option;
  });
}

/** Build a Feishu field body from a friendly object or an OpenAPI field definition. */
export function fieldBody(value: unknown, label: string): Record<string, unknown> {
  const record = asObject(value);
  if (record === undefined) throw new CliError(`${label} must be a JSON object`, 2);
  const type = fieldTypeOf(record.type, label);
  const name = textOf(record.field_name) || textOf(record.name);
  if (name.length === 0) throw new CliError(`${label} needs a field name`, 2);
  const property = fieldProperty(type, record, label);
  const body: Record<string, unknown> = { field_name: name, type };
  if (property !== undefined) body.property = property;
  const uiType = textOf(record.ui_type);
  if (uiType.length > 0) body.ui_type = uiType;
  const description = asObject(record.description);
  if (description !== undefined) body.description = description;
  return body;
}

function fieldProperty(type: number, record: Record<string, unknown>, label: string): Record<string, unknown> | undefined {
  const base = { ...(asObject(record.property) ?? {}) };
  const shorthandTable = textOf(record.table_id) || textOf(record.link_table) || textOf(record.linkTable);
  const shorthandBack = textOf(record.back_field_name) || textOf(record.back_field) || textOf(record.backField);
  const shorthandFormatter = textOf(record.formatter);
  if (shorthandTable.length > 0 && type !== 18 && type !== 21) throw new CliError(`${label} does not use a target table`, 2);
  if (shorthandBack.length > 0 && type !== 21) throw new CliError(`${label} back field is only for a duplex link`, 2);
  if (record.options !== undefined && type !== 3 && type !== 4) throw new CliError(`${label} options are only for a select field`, 2);
  if (shorthandFormatter.length > 0 && type !== 2) throw new CliError(`${label} formatter is only for a number field`, 2);
  if (typeof record.multiple === "boolean" && type !== 18 && type !== 21) throw new CliError(`${label} multiple is only for a link field`, 2);
  if (type === 3 || type === 4) {
    const source = record.options !== undefined ? record.options : base.options;
    base.options = optionList(source, label);
  }
  if (type === 2 && shorthandFormatter.length > 0) base.formatter = shorthandFormatter;
  if (type === 18 || type === 21) {
    const tableId = shorthandTable || textOf(base.table_id);
    if (tableId.length === 0) throw new CliError(`${label} needs a target table`, 2);
    base.table_id = tableId;
    if (typeof record.multiple === "boolean") base.multiple = record.multiple;
  }
  if (type === 21) {
    const back = shorthandBack || textOf(base.back_field_name);
    if (back.length === 0) throw new CliError(`${label} needs the other side field name`, 2);
    base.back_field_name = back;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

export function fieldBodies(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new CliError(`${label} must be a JSON array`, 2);
  if (value.length === 0) throw new CliError(`${label} needs at least one field`, 2);
  if (value.length > 300) throw new CliError(`${label} accepts at most 300 fields`, 2);
  return value.map((item, index) => fieldBody(item, `${label}[${index}]`));
}

export function parseViewType(value: string | undefined): string {
  const type = value ?? "grid";
  if (!VIEW_TYPES.has(type)) throw new CliError("--type must be grid, kanban, gallery, gantt, or form", 2);
  return type;
}

/** Sort accepts at most 10 rules. Group accepts at most 3. An empty array clears the setting. */
export function viewConfig(value: unknown, kind: "sort" | "group"): Record<string, unknown> {
  const key = kind === "sort" ? "sort_config" : "group_config";
  const label = kind === "sort" ? "--sort" : "--group";
  const max = kind === "sort" ? 10 : 3;
  const record = asObject(value);
  const items = Array.isArray(value) ? value : record !== undefined && Array.isArray(record[key]) ? record[key] : undefined;
  if (items === undefined) throw new CliError(`${label} must be a JSON array`, 2);
  if (items.length > max) throw new CliError(`${label} accepts at most ${max} items`, 2);
  const config = items.map((item, index) => {
    const rule = asObject(item);
    if (rule === undefined) throw new CliError(`${label}[${index}] must be an object`, 2);
    const field = textOf(rule.field) || textOf(rule.field_id) || textOf(rule.field_name) || textOf(rule.name);
    if (field.length === 0 || field.length > 100) throw new CliError(`${label}[${index}] needs a field`, 2);
    const desc = rule.desc === undefined ? false : rule.desc;
    if (typeof desc !== "boolean") throw new CliError(`${label}[${index}].desc must be a boolean`, 2);
    return { field, desc };
  });
  return { [key]: config };
}

export async function createApp(client: ApiClient, name: string, folderToken: string | undefined, brand: FeishuBrand): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "POST", "/bitable/v1/apps", {
    json: { name, ...(folderToken === undefined || folderToken.length === 0 ? {} : { folder_token: folderToken }) },
  }));
  const app = asObject(data.app) ?? data;
  const appToken = stringField(app, "app_token");
  if (appToken.length === 0) throw new CliError("Feishu did not return an app token");
  const url = stringField(app, "url");
  const folder = stringField(app, "folder_token") || folderToken || "";
  const tableId = stringField(app, "default_table_id");
  return {
    appToken,
    url: url.length > 0 ? url : resourceUrl(brand, "bitable", appToken),
    name: stringField(app, "name") || name,
    ...(tableId.length > 0 ? { defaultTableId: tableId } : {}),
    ...(folder.length > 0 ? { folderToken: folder } : {}),
  };
}

export async function createTable(
  client: ApiClient,
  appToken: string,
  name: string,
  options: { viewName?: string; fields?: Record<string, unknown>[] } = {},
): Promise<Record<string, unknown>> {
  if (options.viewName !== undefined && options.viewName.length > 0 && options.fields === undefined) {
    throw new CliError("--view-name requires --fields", 2);
  }
  const table: Record<string, unknown> = { name };
  if (options.viewName !== undefined && options.viewName.length > 0) table.default_view_name = options.viewName;
  if (options.fields !== undefined) table.fields = options.fields;
  const data = dataOf(await apiJson(client, "POST", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, { json: { table } }));
  const tableId = stringField(data, "table_id");
  if (tableId.length === 0) throw new CliError("Feishu did not return a table id");
  const viewId = stringField(data, "default_view_id");
  const fieldIdList = Array.isArray(data.field_id_list) ? data.field_id_list.filter((item): item is string => typeof item === "string") : [];
  return {
    tableId,
    ...(viewId.length > 0 ? { defaultViewId: viewId } : {}),
    ...(fieldIdList.length > 0 ? { fieldIdList } : {}),
  };
}

function fieldResult(data: Record<string, unknown>): Record<string, unknown> {
  const field = asObject(data.field) ?? data;
  const fieldId = stringField(field, "field_id");
  if (fieldId.length === 0) throw new CliError("Feishu did not return a field id");
  const type = field.type;
  const property = asObject(field.property);
  return {
    fieldId,
    fieldName: stringField(field, "field_name"),
    ...(typeof type === "number" ? { type } : {}),
    ...(property !== undefined ? { property } : {}),
  };
}

export async function createField(client: ApiClient, appToken: string, tableId: string, field: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "POST", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`, { json: field }));
  return fieldResult(data);
}

export async function updateField(
  client: ApiClient,
  appToken: string,
  tableId: string,
  fieldId: string,
  field: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "PUT", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(fieldId)}`, { json: field }));
  return fieldResult(data);
}

async function putViewConfig(
  client: ApiClient,
  appToken: string,
  tableId: string,
  viewId: string,
  kind: "sort" | "group",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return dataOf(await apiJson(client, "PUT", `/base/v3/bases/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views/${encodeURIComponent(viewId)}/${kind}`, { json: body }));
}

export async function createView(
  client: ApiClient,
  appToken: string,
  tableId: string,
  name: string,
  viewType: string,
  options: { sort?: unknown; group?: unknown } = {},
): Promise<Record<string, unknown>> {
  const sort = options.sort === undefined ? undefined : viewConfig(options.sort, "sort");
  const group = options.group === undefined ? undefined : viewConfig(options.group, "group");
  const data = dataOf(await apiJson(client, "POST", `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/views`, {
    json: { view_name: name, view_type: viewType },
  }));
  const view = asObject(data.view) ?? data;
  const viewId = stringField(view, "view_id");
  if (viewId.length === 0) throw new CliError("Feishu did not return a view id");
  const result: Record<string, unknown> = {
    viewId,
    viewName: stringField(view, "view_name") || name,
    viewType: stringField(view, "view_type") || viewType,
  };
  if (sort !== undefined) result.sort = await putViewConfig(client, appToken, tableId, viewId, "sort", sort);
  if (group !== undefined) result.group = await putViewConfig(client, appToken, tableId, viewId, "group", group);
  return result;
}

export async function setViewSort(client: ApiClient, appToken: string, tableId: string, viewId: string, value: unknown): Promise<Record<string, unknown>> {
  const sort = viewConfig(value, "sort");
  return { viewId, sort: await putViewConfig(client, appToken, tableId, viewId, "sort", sort) };
}

export async function setViewGroup(client: ApiClient, appToken: string, tableId: string, viewId: string, value: unknown): Promise<Record<string, unknown>> {
  const group = viewConfig(value, "group");
  return { viewId, group: await putViewConfig(client, appToken, tableId, viewId, "group", group) };
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

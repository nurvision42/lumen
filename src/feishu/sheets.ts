import { CliError } from "../errors.js";
import { apiJson, dataOf, stringField, type ApiClient } from "./http.js";

export async function sheetInfo(client: ApiClient, token: string): Promise<Record<string, unknown>> {
  const spreadsheet = dataOf(await apiJson(client, "GET", `/sheets/v3/spreadsheets/${encodeURIComponent(token)}`));
  const listed = dataOf(await apiJson(client, "GET", `/sheets/v3/spreadsheets/${encodeURIComponent(token)}/sheets/query`));
  const sheet = spreadsheet.spreadsheet !== null && typeof spreadsheet.spreadsheet === "object" ? spreadsheet.spreadsheet : spreadsheet;
  return { spreadsheet: sheet, sheets: Array.isArray(listed.sheets) ? listed.sheets : [] };
}

export async function createSheet(client: ApiClient, title: string, folderToken: string | undefined): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "POST", "/sheets/v3/spreadsheets", {
    json: { title, ...(folderToken === undefined || folderToken.length === 0 ? {} : { folder_token: folderToken }) },
  }));
  const spreadsheet = data.spreadsheet !== null && typeof data.spreadsheet === "object" ? (data.spreadsheet as Record<string, unknown>) : data;
  const token = stringField(spreadsheet, "spreadsheet_token");
  if (token.length === 0) throw new CliError("Feishu did not return a spreadsheet token");
  return { token, title: stringField(spreadsheet, "title") || title, url: stringField(spreadsheet, "url") };
}

export async function readRange(client: ApiClient, token: string, range: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values/${encodeURIComponent(range)}`, {
    query: { valueRenderOption: "ToString", dateTimeRenderOption: "FormattedString" },
  }));
  const valueRange = data.valueRange !== null && typeof data.valueRange === "object" ? data.valueRange : data;
  return { token, range, valueRange };
}

export async function writeRange(client: ApiClient, token: string, range: string, values: unknown): Promise<Record<string, unknown>> {
  if (!Array.isArray(values)) throw new CliError("--values must be a JSON array of rows", 2);
  const data = dataOf(await apiJson(client, "PUT", `/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values`, {
    json: { valueRange: { range, values } },
  }));
  return { token, range, updated: data };
}

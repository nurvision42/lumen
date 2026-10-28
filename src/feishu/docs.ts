import { CliError } from "../errors.js";
import { rootFolderToken } from "./drive.js";
import { apiJson, dataOf, numberField, stringField, type ApiClient } from "./http.js";

export type DocKind = "docx" | "doc";

export function parseDocKind(value: string | undefined): DocKind {
  if (value === undefined || value === "docx") return "docx";
  if (value === "doc") return "doc";
  throw new CliError("--kind must be docx or doc", 2);
}

export async function readDoc(client: ApiClient, token: string, kind: DocKind): Promise<{ token: string; kind: DocKind; content: string }> {
  if (kind === "doc") {
    const data = dataOf(await apiJson(client, "GET", `/doc/v2/${encodeURIComponent(token)}/raw_content`));
    return { token, kind, content: stringField(data, "content") };
  }
  const data = dataOf(await apiJson(client, "GET", `/docx/v1/documents/${encodeURIComponent(token)}/raw_content`));
  return { token, kind, content: stringField(data, "content") };
}

export async function createDoc(
  client: ApiClient,
  kind: DocKind,
  title: string,
  folderToken: string | undefined,
): Promise<{ token: string; kind: DocKind; title: string }> {
  if (kind === "docx") {
    const data = dataOf(await apiJson(client, "POST", "/docx/v1/documents", {
      json: { title, ...(folderToken === undefined || folderToken.length === 0 ? {} : { folder_token: folderToken }) },
    }));
    const document = data.document !== null && typeof data.document === "object" ? (data.document as Record<string, unknown>) : data;
    const token = stringField(document, "document_id");
    if (token.length === 0) throw new CliError("Feishu did not return a document id");
    return { token, kind, title: stringField(document, "title") || title };
  }
  const folder = folderToken === undefined || folderToken.length === 0 ? await rootFolderToken(client) : folderToken;
  const data = dataOf(await apiJson(client, "POST", `/drive/explorer/v2/file/${encodeURIComponent(folder)}`, {
    json: { title, type: "doc" },
  }));
  const token = stringField(data, "token");
  if (token.length === 0) throw new CliError("Feishu did not return a classic doc token");
  return { token, kind, title };
}

export async function writeDoc(
  client: ApiClient,
  token: string,
  kind: DocKind,
  text: string,
  mode: "append" | "replace",
): Promise<{ token: string; kind: DocKind; mode: "append" | "replace"; paragraphs: number }> {
  const paragraphs = text.split(/\r?\n/);
  if (kind === "doc") {
    if (mode === "replace") throw new CliError("classic doc write appends paragraphs; use --kind docx --mode replace to replace the body");
    await appendClassic(client, token, paragraphs);
    return { token, kind, mode, paragraphs: paragraphs.length };
  }
  if (mode === "replace") {
    const count = await pageChildCount(client, token);
    if (count > 0) {
      await apiJson(client, "DELETE", `/docx/v1/documents/${encodeURIComponent(token)}/blocks/${encodeURIComponent(token)}/children/batch_delete`, {
        json: { start_index: 0, end_index: count },
      });
    }
  }
  const index = mode === "replace" ? 0 : await pageChildCount(client, token);
  await apiJson(client, "POST", `/docx/v1/documents/${encodeURIComponent(token)}/blocks/${encodeURIComponent(token)}/children`, {
    json: { index, children: paragraphs.map(textBlock) },
  });
  return { token, kind, mode, paragraphs: paragraphs.length };
}

function textBlock(content: string): Record<string, unknown> {
  return {
    block_type: 2,
    text: { elements: [{ text_run: { content } }], style: {} },
  };
}

async function pageChildCount(client: ApiClient, token: string): Promise<number> {
  let pageToken: string | undefined;
  let count = 0;
  let found = false;
  do {
    const data = dataOf(await apiJson(client, "GET", `/docx/v1/documents/${encodeURIComponent(token)}/blocks`, {
      query: { page_size: "500", page_token: pageToken },
    }));
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (stringField(row, "block_id") !== token && numberField(row, "block_type") !== 1) continue;
      const children = row.children;
      count = Array.isArray(children) ? children.length : 0;
      found = true;
    }
    const next = stringField(data, "page_token");
    pageToken = data.has_more === true && next.length > 0 ? next : undefined;
  } while (pageToken !== undefined);
  if (!found) return 0;
  return count;
}

async function appendClassic(client: ApiClient, token: string, paragraphs: string[]): Promise<void> {
  const payload = JSON.stringify({
    blocks: paragraphs.map((text) => ({
      type: "paragraph",
      paragraph: { elements: [{ type: "textRun", textRun: { text, style: {} } }], style: {} },
    })),
  });
  const request = JSON.stringify({
    requestType: "InsertBlocksRequestType",
    insertBlocksRequest: { payload, location: { zoneId: "0", index: 0, endOfZone: true } },
  });
  await apiJson(client, "POST", `/doc/v2/${encodeURIComponent(token)}/batch_update`, { json: { Requests: [request] } });
}

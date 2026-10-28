import { CliError } from "../errors.js";
import { apiJson, asObject, dataOf, stringField, type ApiClient } from "./http.js";
import { resourceUrl, type FeishuBrand } from "./endpoints.js";

function page(data: Record<string, unknown>, items: unknown): Record<string, unknown> {
  const next = stringField(data, "page_token");
  return { items, hasMore: data.has_more === true, ...(next.length > 0 ? { pageToken: next } : {}) };
}

const SPACE_PAGE_LIMIT = 100;

/**
 * List every wiki space the user can open.
 * Pages can be empty while has_more is still true, so this follows page_token until has_more is false.
 * The list API does not include 我的文档库; that space is loaded from /wiki/v2/spaces/my_library.
 */
export async function listSpaces(client: ApiClient, pageToken?: string, lang = "zh"): Promise<Record<string, unknown>> {
  const items: unknown[] = [];
  let token = pageToken;
  const seen = new Set<string>();
  for (let page = 0; page < SPACE_PAGE_LIMIT; page += 1) {
    if (token !== undefined && token.length > 0) {
      if (seen.has(token)) throw new CliError("Feishu wiki spaces pagination did not advance");
      seen.add(token);
    }
    const data = dataOf(await apiJson(client, "GET", "/wiki/v2/spaces", {
      query: { page_size: "50", page_token: token },
    }));
    if (Array.isArray(data.items)) items.push(...data.items);
    if (data.has_more !== true) {
      token = undefined;
      break;
    }
    const next = stringField(data, "page_token");
    if (next.length === 0) throw new CliError("Feishu wiki spaces returned has_more without a page token");
    token = next;
  }
  if (token !== undefined && token.length > 0) throw new CliError("Feishu wiki spaces pagination did not finish");
  const library = await myLibrary(client, lang);
  const libraryId = stringField(library, "space_id");
  const already = items.some((item) => asObject(item) !== undefined && stringField(asObject(item), "space_id") === libraryId);
  if (!already) items.unshift(library);
  return { items, hasMore: false };
}

async function myLibrary(client: ApiClient, lang: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", "/wiki/v2/spaces/my_library", { query: { lang } }));
  const space = asObject(data.space) ?? data;
  if (stringField(space, "space_id").length === 0) throw new CliError("Feishu did not return the personal document library");
  return space;
}

export async function listNodes(client: ApiClient, spaceId: string, parent?: string, pageToken?: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
    query: { page_size: "50", page_token: pageToken, parent_node_token: parent },
  }));
  return page(data, Array.isArray(data.items) ? data.items : []);
}

export async function getNode(client: ApiClient, token: string, brand: FeishuBrand): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", "/wiki/v2/spaces/get_node", { query: { token } }));
  const node = data.node !== null && typeof data.node === "object" ? (data.node as Record<string, unknown>) : data;
  const objType = stringField(node, "obj_type");
  const objToken = stringField(node, "obj_token");
  const nodeToken = stringField(node, "node_token") || token;
  return {
    title: stringField(node, "title"),
    spaceId: stringField(node, "space_id"),
    nodeToken,
    objType,
    objToken,
    parentNodeToken: stringField(node, "parent_node_token"),
    url: resourceUrl(brand, "wiki", nodeToken),
    objUrl: objToken.length > 0 ? resourceUrl(brand, objType || "docx", objToken) : "",
  };
}

export async function searchWiki(client: ApiClient, brand: FeishuBrand, query: string, spaceId?: string, pageToken?: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "POST", "/wiki/v1/nodes/search", {
    query: { page_size: "20", page_token: pageToken },
    json: { query, ...(spaceId === undefined || spaceId.length === 0 ? {} : { space_id: spaceId }) },
  }));
  const items = (Array.isArray(data.items) ? data.items : []).map((item) => {
    const row = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const nodeToken = stringField(row, "node_id") || stringField(row, "node_token");
    const objType = stringField(row, "obj_type");
    const objToken = stringField(row, "obj_token");
    const url = stringField(row, "url");
    return {
      title: stringField(row, "title"),
      spaceId: stringField(row, "space_id"),
      nodeToken,
      objType,
      objToken,
      url: url.length > 0 ? url : resourceUrl(brand, "wiki", nodeToken),
    };
  });
  return page(data, items);
}

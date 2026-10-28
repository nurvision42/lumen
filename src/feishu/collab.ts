import { apiJson, dataOf, stringField, type ApiClient } from "./http.js";

export async function listComments(client: ApiClient, token: string, type: string, pageToken?: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/drive/v1/files/${encodeURIComponent(token)}/comments`, {
    query: { file_type: type, page_size: "50", page_token: pageToken },
  }));
  const next = stringField(data, "page_token");
  return { items: Array.isArray(data.items) ? data.items : [], hasMore: data.has_more === true, ...(next.length > 0 ? { pageToken: next } : {}) };
}

export async function addComment(client: ApiClient, token: string, type: string, text: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "POST", `/drive/v1/files/${encodeURIComponent(token)}/comments`, {
    query: { file_type: type },
    json: {
      reply_list: {
        replies: [{ content: { elements: [{ type: "text_run", text_run: { text } }] } }],
      },
    },
  }));
  return { comment: data };
}

export async function getPermission(client: ApiClient, token: string, type: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/drive/v1/permissions/${encodeURIComponent(token)}/public`, { query: { type } }));
  const permission = data.permission_public !== null && typeof data.permission_public === "object" ? data.permission_public : data;
  return { permission };
}

export async function listMembers(client: ApiClient, token: string, type: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/drive/v1/permissions/${encodeURIComponent(token)}/members`, { query: { type } }));
  return { items: Array.isArray(data.items) ? data.items : data };
}

export async function updateShare(client: ApiClient, token: string, type: string, link: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "PATCH", `/drive/v1/permissions/${encodeURIComponent(token)}/public`, {
    query: { type },
    json: { link_share_entity: link },
  }));
  return { permission: data };
}

export async function grantMember(
  client: ApiClient,
  token: string,
  type: string,
  memberId: string,
  memberType: string,
  perm: string,
): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "POST", `/drive/v1/permissions/${encodeURIComponent(token)}/members`, {
    query: { type, need_notification: "false" },
    json: { member_type: memberType, member_id: memberId, perm },
  }));
  return { member: data };
}

export async function whiteboardNodes(client: ApiClient, token: string): Promise<Record<string, unknown>> {
  const data = dataOf(await apiJson(client, "GET", `/board/v1/whiteboards/${encodeURIComponent(token)}/nodes`));
  return { nodes: data.nodes ?? data.items ?? data };
}

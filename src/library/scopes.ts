/**
 * Tenant scopes requested when a Feishu app is created, chosen on the confirm page, or reauthorized.
 *
 * `bitable:app` is the manage scope for the v1 Base APIs. The `base:*` names are the granular
 * create / read / update / delete scopes for the Base, its tables, fields, records, and roles.
 * Views use `base:view:read` and `base:view:write_only`. `drive:drive` covers that app's own
 * drive. It does not list every Base in the tenant. `drive:file` and `docs:document.media:upload`
 * upload material. `docs:permission.member:create` adds a collaborator. `wiki:wiki` resolves a
 * wiki link to the Base it holds.
 */
export const feishuLibraryTenantScopes = [
  "bitable:app",
  "base:app:create",
  "base:app:read",
  "base:app:update",
  "base:table:create",
  "base:table:read",
  "base:table:update",
  "base:table:delete",
  "base:field:create",
  "base:field:read",
  "base:field:update",
  "base:field:delete",
  "base:record:create",
  "base:record:read",
  "base:record:update",
  "base:record:delete",
  "base:view:read",
  "base:view:write_only",
  "base:role:create",
  "base:role:read",
  "base:role:update",
  "base:role:delete",
  "drive:drive",
  "drive:file",
  "docs:permission.member:create",
  "docs:document.media:upload",
  "wiki:wiki",
] as const;

/**
 * User scopes for the signed-in person's drive and Bases.
 *
 * `space:document:retrieve` lists folders in that person's My Space, not the whole tenant.
 * `offline_access` is what makes Feishu return a refresh token. The Base scopes match the
 * tenant list so later reads and writes can run as the user. This is not a read-only login.
 */
export const feishuLibraryUserScopes = [
  "offline_access",
  "bitable:app",
  "base:app:create",
  "base:app:read",
  "base:app:update",
  "base:table:create",
  "base:table:read",
  "base:table:update",
  "base:table:delete",
  "base:field:create",
  "base:field:read",
  "base:field:update",
  "base:field:delete",
  "base:record:create",
  "base:record:read",
  "base:record:update",
  "base:record:delete",
  "base:view:read",
  "base:view:write_only",
  "base:role:create",
  "base:role:read",
  "base:role:update",
  "base:role:delete",
  "space:document:retrieve",
  "drive:file",
  "docs:permission.member:create",
  "docs:document.media:upload",
  "wiki:wiki",
] as const;

const feishuScopeName = /^[a-z][a-z0-9_]*(?:[.:][a-z0-9_]+)+$/u;

export function feishuScopeNameOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name.length > 200 || !feishuScopeName.test(name)) return undefined;
  return name;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Tenant scope names already present on an app. User-only scopes are left out. */
export function tenantScopesFromOpenPlatform(...payloads: readonly unknown[]): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    const name = feishuScopeNameOf(value);
    if (name === undefined || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  const take = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const entry = asRecord(item);
      if (entry === undefined) continue;
      if (typeof entry.scope_name === "string") {
        const status = entry.grant_status;
        if (status !== undefined && status !== 1 && status !== 2) continue;
        push(entry.scope_name);
        continue;
      }
      if (typeof entry.scope !== "string") continue;
      const types = entry.token_types;
      if (!Array.isArray(types) || !types.includes("tenant")) continue;
      push(entry.scope);
    }
  };
  for (const payload of payloads) {
    const body = asRecord(payload);
    if (body === undefined || (body.code !== undefined && body.code !== 0)) continue;
    const data = asRecord(body.data) ?? body;
    take(data.scopes);
    take(asRecord(data.app)?.scopes);
    take(asRecord(data.app_version)?.scopes);
  }
  return names;
}

/**
 * Scopes placed in the app-confirm QR. The library list is always first. Scopes already
 * configured on the app follow, so an Open Platform addition is not replaced by this list.
 */
export function feishuLibraryConnectScopes(configured: readonly string[] = []): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const scope of [...feishuLibraryTenantScopes, ...configured]) {
    const name = feishuScopeNameOf(scope);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

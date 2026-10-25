import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import {
  authorizeFeishuUser,
  type FeishuRegistration,
  type FeishuUserAuthorization,
  type FeishuUserAuthorize,
} from "./oauth.js";
import { assetFields, assetTableName, fieldTypeLabel } from "./schema.js";
import { feishuLibraryConnectScopes, feishuLibraryTenantScopes, feishuLibraryUserScopes, tenantScopesFromOpenPlatform } from "./scopes.js";
import { appCredentialFile, libraryStateFile, readJsonFile, userCredentialFile, writeJsonFile } from "./store.js";

export type FeishuLibraryState = {
  readonly format: "lumen.feishu-library@1";
  readonly appId: string;
  readonly appToken?: string;
  readonly tableId?: string;
  readonly defaultTableId?: string;
  readonly url?: string;
  readonly userOpenId?: string;
  readonly userCanEdit?: boolean;
};

export type FeishuLibraryStatus = {
  readonly connected: boolean;
  readonly appId?: string;
  readonly tableId?: string;
  readonly url?: string;
  readonly userCanEdit?: boolean;
  readonly userSignedIn?: boolean;
};

export type FeishuLibraryRecord = { readonly record_id: string; readonly fields: Record<string, unknown> };

export type AssetInput = {
  readonly name: string;
  readonly type: string;
  readonly person?: string;
  readonly provider?: string;
  readonly account?: string;
  readonly externalId?: string;
  readonly sourceFile?: string;
  readonly status?: string;
  readonly note?: string;
};

export type FeishuDriveBase = {
  readonly token: string;
  readonly name: string;
  readonly url?: string;
};

export type FeishuBaseChoice =
  | { readonly action: "existing"; readonly baseUrl?: string; readonly appToken?: string; readonly tableId?: string }
  | { readonly action: "create" };

export type FeishuLibraryChooser = (bases: readonly FeishuDriveBase[]) => Promise<FeishuBaseChoice>;

export type ParsedFeishuBaseUrl = {
  readonly kind: "base" | "wiki";
  readonly token: string;
  readonly tableId?: string;
  readonly url: string;
};

export type FeishuBindRequest = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl?: string;
  readonly appToken?: string;
  readonly tableId?: string;
  readonly userOpenId?: string;
  readonly create?: boolean;
  readonly onUserQr?: (url: string, expireIn: number) => void | Promise<void>;
  readonly authorizeUser?: FeishuUserAuthorize;
};

type BitableField = { readonly field_name: string; readonly type: number; readonly field_id?: string };

type FeishuUserSession = {
  readonly client_id: string;
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_at: number;
  readonly refresh_expires_at?: number;
  readonly open_id?: string;
  readonly scope?: string;
};

type ResolvedBindTarget = {
  readonly appToken?: string;
  readonly wikiToken?: string;
  readonly tableId?: string;
  readonly url?: string;
};

const feishuLinkHosts = ["feishu.cn", "larksuite.com", "larkoffice.com"];
const documentManagePermission = "full_access";
const editRecordsAndFields = 4;
const advancedEditorRole = "lumen 素材库";
const advancedPermissionNote = "This base has advanced permissions. lumen tried to add the signed-in user to a role that can edit records and fields. The app itself cannot be added through the API. If deletes are still refused, add the app from the base menu: … → more → add document app, on a role that can edit records and fields.";

export type FeishuLibraryOptions = {
  readonly home: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBase?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CliError(`Feishu asset library is missing ${label}`);
  return value.trim();
}

function scrub(message: string, secrets: readonly (string | undefined)[]): string {
  let text = message;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 8 || !text.includes(secret)) continue;
    text = text.split(secret).join("***");
  }
  return text;
}

function clean(value: string): string {
  return value.normalize("NFKC").trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function feishuHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return feishuLinkHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function parseFeishuBaseUrl(value: string): ParsedFeishuBaseUrl {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CliError("Could not parse the Feishu base link. Paste a full https link, or pass --app-token.");
  }
  if (url.protocol !== "https:" || !feishuHost(url.hostname)) {
    throw new CliError("Only https Feishu or Lark base links are accepted");
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const kind = parts[0];
  const token = parts[1];
  if ((kind !== "base" && kind !== "wiki") || token === undefined || !/^[A-Za-z0-9]+$/u.test(token)) {
    throw new CliError("The link must point at /base/ or /wiki/");
  }
  const table = url.searchParams.get("table") ?? undefined;
  if (table !== undefined && !/^tbl[A-Za-z0-9]+$/u.test(table)) {
    throw new CliError("The table id in the link was not recognized");
  }
  return { kind, token, ...(table === undefined ? {} : { tableId: table }), url: url.toString() };
}

function resolvedBindTarget(request: Pick<FeishuBindRequest, "baseUrl" | "appToken" | "tableId">): ResolvedBindTarget {
  const appToken = request.appToken?.trim();
  const tableId = request.tableId?.trim();
  if (appToken !== undefined && appToken.length > 0 && /[:/\s]/u.test(appToken)) {
    throw new CliError("--app-token must be the base token. Pass a link with --base-url.");
  }
  if (tableId !== undefined && tableId.length > 0 && !/^tbl[A-Za-z0-9]+$/u.test(tableId)) {
    throw new CliError("--table-id must start with tbl");
  }
  const parsed = request.baseUrl === undefined || request.baseUrl.trim() === "" ? undefined : parseFeishuBaseUrl(request.baseUrl);
  const explicitToken = appToken === undefined || appToken.length === 0 ? undefined : appToken;
  const explicitTable = tableId === undefined || tableId.length === 0 ? undefined : tableId;
  if (parsed?.kind === "base" && explicitToken !== undefined && parsed.token !== explicitToken) {
    throw new CliError("The base link and --app-token do not match");
  }
  if (parsed?.kind === "wiki" && explicitToken !== undefined) {
    throw new CliError("Pass either a wiki link or --app-token, not both");
  }
  if (parsed?.tableId !== undefined && explicitTable !== undefined && parsed.tableId !== explicitTable) {
    throw new CliError("The table in the link and --table-id do not match");
  }
  const table = explicitTable ?? parsed?.tableId;
  return {
    ...(parsed?.kind === "base" ? { appToken: explicitToken ?? parsed.token } : explicitToken === undefined ? {} : { appToken: explicitToken }),
    ...(parsed?.kind === "wiki" ? { wikiToken: parsed.token } : {}),
    ...(table === undefined ? {} : { tableId: table }),
    ...(parsed === undefined ? {} : { url: parsed.url }),
  };
}

export function redactedTableUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/\/(base|wiki)\/[^/?#]+/u, "/$1/***");
}

function columnMismatch(name: string, actual: number, expected: number): CliError {
  return new CliError(
    `Column ${name} is ${fieldTypeLabel(actual)}; the asset library needs ${fieldTypeLabel(expected)}. Change that column in Feishu. lumen will not change an existing column type and will not create another base.`,
  );
}

function missingBaseChoice(): CliError {
  return new CliError("No base selected. Pass --base-url or --app-token, or pass --create. A base is not created automatically.");
}

function safeApiPath(requestPath: string): string {
  const route = requestPath.split("?")[0] ?? requestPath;
  return route
    .replace(/\/apps\/[^/]+/gu, "/apps/***")
    .replace(/\/permissions\/[^/]+/gu, "/permissions/***")
    .replace(/\/medias\/[^/]+/gu, "/medias/***");
}

function assetName(record: FeishuLibraryRecord): string {
  return clean(String(record.fields["名称"] ?? "")).toLocaleLowerCase();
}

function userSessionUsable(session: FeishuUserSession | undefined, appId: string | undefined, now: number): boolean {
  if (session === undefined || appId === undefined || session.client_id !== appId) return false;
  if (session.expires_at > now + 60_000) return true;
  return session.refresh_token !== undefined && session.refresh_token !== ""
    && (session.refresh_expires_at === undefined || session.refresh_expires_at > now);
}

function sessionFromAuthorization(clientId: string, result: FeishuUserAuthorization, now: number, previous?: FeishuUserSession): FeishuUserSession {
  const refresh = result.refresh_token ?? previous?.refresh_token;
  const refreshIn = result.refresh_token_expires_in;
  return {
    client_id: clientId,
    access_token: result.access_token,
    ...(refresh === undefined || refresh === "" ? {} : { refresh_token: refresh }),
    expires_at: now + Math.max(60, result.expires_in) * 1000,
    ...(refreshIn === undefined
      ? previous?.refresh_expires_at === undefined ? {} : { refresh_expires_at: previous.refresh_expires_at }
      : { refresh_expires_at: now + refreshIn * 1000 }),
    ...(result.open_id !== undefined ? { open_id: result.open_id } : previous?.open_id === undefined ? {} : { open_id: previous.open_id }),
    ...(result.scope !== undefined ? { scope: result.scope } : {}),
  };
}

const appPreset = { name: "lumen 素材库", desc: "Reusable people, voices, and reference assets" };

export class FeishuLibrary {
  readonly #home: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #base: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #access?: { value: string; expiresAt: number; appId: string };
  #advancedPermissionNote?: string;

  constructor(options: FeishuLibraryOptions) {
    this.#home = options.home;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = (options.apiBase ?? "https://open.feishu.cn/open-apis").replace(/\/+$/u, "");
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#now = options.now ?? Date.now;
  }

  advancedPermissionNote(): string | undefined {
    return this.#advancedPermissionNote;
  }

  async secretValues(): Promise<readonly string[]> {
    const registration = await this.#registration();
    const session = await this.#userSession();
    return [registration?.client_secret, session?.access_token, session?.refresh_token, this.#access?.value].filter(
      (item): item is string => typeof item === "string" && item.length >= 8,
    );
  }

  async status(): Promise<FeishuLibraryStatus> {
    const registration = await this.#registration();
    const state = await this.#state();
    const url = redactedTableUrl(state?.url);
    const session = await this.#userSession();
    return {
      connected: registration !== undefined && state?.tableId !== undefined && state.userCanEdit === true,
      ...(state === undefined ? {} : {
        appId: state.appId,
        ...(state.tableId === undefined ? {} : { tableId: state.tableId }),
        ...(url === undefined ? {} : { url }),
        userCanEdit: state.userCanEdit === true,
        userSignedIn: userSessionUsable(session, state.appId, this.#now()),
      }),
    };
  }

  async connect(
    register: (request: {
      readonly appId?: string;
      readonly appPreset: { readonly name: string; readonly desc: string };
      readonly addons: { readonly preset: false; readonly scopes: { readonly tenant: readonly string[]; readonly user: readonly string[] } };
      readonly onQRCodeReady: (info: { readonly url: string; readonly expireIn: number }) => void | Promise<void>;
    }) => Promise<FeishuRegistration>,
    onQr: (url: string, expireIn: number) => void | Promise<void>,
    reauthorize = false,
    choose?: FeishuLibraryChooser,
    authorizeUser: FeishuUserAuthorize = (request) => authorizeFeishuUser({ ...request, fetch: this.#fetch, sleep: this.#sleep, apiBase: this.#base }),
  ): Promise<FeishuLibraryState> {
    return await this.#locked("connect", async () => {
      let registration = await this.#registration();
      const discovered = registration === undefined ? undefined : await this.#configuredTenantScopes(registration);
      const configured = discovered !== undefined && discovered.ok ? discovered.scopes : [];
      const configuredSet = new Set(configured);
      const libraryScopesMissing = discovered !== undefined && discovered.ok
        && feishuLibraryTenantScopes.some((scope) => !configuredSet.has(scope));
      if (registration === undefined || reauthorize || libraryScopesMissing) {
        const result = await register({
          ...(registration === undefined ? {} : { appId: registration.client_id }),
          appPreset,
          addons: {
            preset: false,
            scopes: { tenant: feishuLibraryConnectScopes(configured), user: [...feishuLibraryUserScopes] },
          },
          onQRCodeReady: (info) => onQr(info.url, info.expireIn),
        });
        registration = {
          client_id: required(result.client_id, "an app id"),
          client_secret: required(result.client_secret, "an app secret"),
          ...(result.user_info === undefined ? {} : { user_info: result.user_info }),
        };
        await this.#storeRegistration(registration);
        this.#access = undefined;
      }
      const connected = registration;
      const saved = await this.#state();
      if (saved !== undefined && saved.appId !== connected.client_id) {
        throw new CliError("The saved asset library belongs to a different Feishu app. Run: lumen library connect feishu --reauthorize, or bind the other app with --existing.");
      }
      const session = await this.#ensureUser(connected, onQr, reauthorize, authorizeUser);
      const openId = session.open_id ?? connected.user_info?.open_id;
      let state: FeishuLibraryState = saved ?? {
        format: "lumen.feishu-library@1",
        appId: connected.client_id,
        ...(openId === undefined ? {} : { userOpenId: openId }),
      };
      if (state.userOpenId === undefined && openId !== undefined) state = { ...state, userOpenId: openId };
      await this.#save(state);
      if (state.appToken !== undefined && state.tableId !== undefined) {
        await this.#ensureColumns(connected, state.appToken, state.tableId);
        return await this.#finishConnected(connected, state);
      }
      if (choose === undefined) throw missingBaseChoice();
      let bases: readonly FeishuDriveBase[] = [];
      try {
        bases = await this.#listUserBases(connected);
      } catch {
        bases = [];
      }
      const choice = await choose(bases);
      if (choice.action === "create") {
        state = await this.#createBase(connected, state, "user");
        state = await this.#findOrCreateLibraryTable(connected, state);
      } else {
        state = await this.#adoptExisting(connected, state, choice);
      }
      return await this.#finishConnected(connected, state);
    });
  }

  async bind(request: FeishuBindRequest): Promise<FeishuLibraryState> {
    return await this.#locked("connect", async () => {
      const clientId = required(request.clientId, "an app id");
      if (!/^cli_[A-Za-z0-9]+$/u.test(clientId)) throw new CliError("--app-id must start with cli_");
      const clientSecret = required(request.clientSecret, "an app secret");
      const openId = request.userOpenId?.trim();
      const registration: FeishuRegistration = {
        client_id: clientId,
        client_secret: clientSecret,
        ...(openId === undefined || openId.length === 0 ? {} : { user_info: { open_id: openId } }),
      };
      const target = resolvedBindTarget(request);
      let appToken = target.appToken;
      let tableId = target.tableId;
      try {
        this.#access = undefined;
        await this.#token(registration);
        if (target.wikiToken !== undefined) appToken = await this.#wikiAppToken(registration, target.wikiToken);
        if (appToken !== undefined) {
          const tables = await this.#listTables(registration, appToken);
          if (tableId !== undefined) {
            if (!tables.some((item) => item.table_id === tableId)) throw new CliError("That table is not in this base");
          } else {
            tableId = tables.find((item) => item.name === assetTableName)?.table_id;
          }
          if (tableId !== undefined) await this.#assertColumnsCompatible(registration, appToken, tableId);
        } else {
          const saved = await this.#state();
          const resumable = saved?.appId === clientId && saved.appToken !== undefined && saved.tableId !== undefined;
          if (resumable && saved.appToken !== undefined && saved.tableId !== undefined) {
            await this.#assertColumnsCompatible(registration, saved.appToken, saved.tableId);
          } else if (request.create !== true && target.wikiToken === undefined) {
            throw missingBaseChoice();
          } else if (request.create === true && request.onUserQr !== undefined && await this.#usableUserToken(registration) === undefined) {
            const signIn = request.authorizeUser ?? ((options) => authorizeFeishuUser({ ...options, fetch: this.#fetch, sleep: this.#sleep, apiBase: this.#base }));
            await this.#ensureUser(registration, request.onUserQr, true, signIn);
          }
        }
      } catch (error) {
        throw new CliError(scrub(error instanceof Error ? error.message : String(error), [clientSecret]));
      }

      await this.#storeRegistration(registration);
      const saved = await this.#state();
      const sameApp = saved?.appId === clientId ? saved : undefined;
      const session = await this.#userSession();
      const signedInOpenId = session?.client_id === clientId ? session.open_id : undefined;
      const carriedUrl = target.url ?? (sameApp?.appToken !== undefined && sameApp.appToken === appToken ? sameApp.url : undefined);
      const carriedOpenId = registration.user_info?.open_id
        ?? signedInOpenId
        ?? (sameApp?.appToken !== undefined && sameApp.appToken === appToken ? sameApp.userOpenId : undefined);
      let state: FeishuLibraryState = appToken === undefined && sameApp !== undefined
        ? { ...sameApp, ...(carriedOpenId === undefined ? {} : { userOpenId: carriedOpenId }) }
        : {
          format: "lumen.feishu-library@1",
          appId: clientId,
          ...(appToken === undefined ? {} : { appToken }),
          ...(tableId === undefined ? {} : { tableId }),
          ...(carriedUrl === undefined ? {} : { url: carriedUrl }),
          ...(carriedOpenId === undefined ? {} : { userOpenId: carriedOpenId }),
        };
      await this.#save(state);
      if (state.appToken === undefined) {
        if (request.create !== true) throw missingBaseChoice();
        const identity = await this.#usableUserToken(registration) === undefined ? "tenant" : "user";
        state = await this.#createBase(registration, state, identity);
      }
      if (state.tableId === undefined) state = await this.#findOrCreateLibraryTable(registration, state);
      await this.#ensureColumns(registration, required(state.appToken, "a base token"), required(state.tableId, "a table id"));
      if (state.userCanEdit !== true) {
        if (state.userOpenId !== undefined || registration.user_info?.open_id !== undefined) {
          try {
            state = await this.#grantEditor(registration, state);
          } catch (error) {
            const session = await this.#userSession();
            if (session?.client_id !== registration.client_id) throw error;
          }
        }
      }
      await this.#ensureAdvancedRole(registration, state);
      await this.#probe(registration, state);
      if (state.userCanEdit !== true) {
        state = { ...state, userCanEdit: true };
        await this.#save(state);
      }
      return await this.#dropStarter(registration, state);
    });
  }

  async records(): Promise<readonly FeishuLibraryRecord[]> {
    const { registration, state } = await this.#ready();
    const appToken = required(state.appToken, "a base token");
    const tableId = required(state.tableId, "a table id");
    const items: FeishuLibraryRecord[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "500", ...(pageToken === undefined ? {} : { page_token: pageToken }) });
      const result = await this.#api<{ items?: FeishuLibraryRecord[]; has_more?: boolean; page_token?: string }>(
        registration,
        "GET",
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${query}`,
      );
      items.push(...(result.items ?? []));
      pageToken = result.has_more === true ? required(result.page_token, "a page token") : undefined;
    } while (pageToken !== undefined);
    return items;
  }

  async find(name: string, type?: string): Promise<readonly FeishuLibraryRecord[]> {
    const target = clean(required(name, "an asset name")).toLocaleLowerCase();
    return (await this.records()).filter((item) => assetName(item) === target && (type === undefined || item.fields["类型"] === type));
  }

  async add(input: AssetInput): Promise<FeishuLibraryRecord> {
    return await this.#locked("write", async () => {
      const name = clean(required(input.name, "an asset name"));
      const type = clean(required(input.type, "an asset type"));
      const existing = await this.find(name, type);
      const matched = existing.find((item) => item.fields["服务商"] === (input.provider ?? "") && item.fields["账户"] === (input.account ?? ""));
      if (matched !== undefined) {
        if (input.externalId !== undefined && matched.fields["服务商编号"] === input.externalId) return matched;
        throw new CliError(`Asset “${name}” already has a record for that type and provider account. lumen will not overwrite it.`);
      }
      return await this.#create({
        "名称": name,
        "类型": type,
        "人物": input.person ?? "",
        "服务商": input.provider ?? "",
        "账户": input.account ?? "",
        "服务商编号": input.externalId ?? "",
        "状态": input.status ?? "可用",
        "备注": input.note ?? "",
      }, input.sourceFile);
    });
  }

  async #registration(): Promise<FeishuRegistration | undefined> {
    const saved = await readJsonFile(appCredentialFile(this.#home));
    if (saved === undefined) return undefined;
    const value = asRecord(saved);
    if (value === undefined) throw new CliError("Saved Feishu app credential could not be parsed. Run: lumen library connect feishu --reauthorize");
    return {
      client_id: required(value.client_id, "an app id"),
      client_secret: required(value.client_secret, "an app secret"),
      ...(asRecord(value.user_info) === undefined ? {} : {
        user_info: {
          ...(typeof asRecord(value.user_info)?.open_id === "string" ? { open_id: String(asRecord(value.user_info)?.open_id) } : {}),
          ...(typeof asRecord(value.user_info)?.tenant_brand === "string" ? { tenant_brand: String(asRecord(value.user_info)?.tenant_brand) } : {}),
        },
      }),
    };
  }

  async #state(): Promise<FeishuLibraryState | undefined> {
    const saved = await readJsonFile(libraryStateFile(this.#home));
    if (saved === undefined) return undefined;
    const value = asRecord(saved);
    if (value?.format !== "lumen.feishu-library@1" || typeof value.appId !== "string") {
      throw new CliError("Saved Feishu library selection could not be parsed. Run: lumen library connect feishu");
    }
    return value as FeishuLibraryState;
  }

  async #save(state: FeishuLibraryState): Promise<void> {
    await writeJsonFile(libraryStateFile(this.#home), state);
  }

  async #storeRegistration(registration: FeishuRegistration): Promise<void> {
    await writeJsonFile(appCredentialFile(this.#home), registration);
  }

  async #userSession(): Promise<FeishuUserSession | undefined> {
    const saved = await readJsonFile(userCredentialFile(this.#home));
    if (saved === undefined) return undefined;
    const value = asRecord(saved);
    if (value === undefined || typeof value.client_id !== "string" || typeof value.access_token !== "string" || typeof value.expires_at !== "number") {
      throw new CliError("Saved Feishu user login could not be parsed. Run: lumen library connect feishu");
    }
    return value as FeishuUserSession;
  }

  async #storeUser(session: FeishuUserSession): Promise<void> {
    await writeJsonFile(userCredentialFile(this.#home), session);
  }

  async #locked<T>(name: string, task: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.#home, "library", `${name}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = this.#now() - (await stat(lockPath)).mtimeMs;
      if (age <= 30 * 60_000) throw new CliError("Another lumen process is writing the asset library. Wait for it to finish.");
      await rm(lockPath, { force: true });
      handle = await open(lockPath, "wx", 0o600);
    }
    try {
      return await task();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }

  async #ensureUser(
    registration: FeishuRegistration,
    onQr: (url: string, expireIn: number) => void | Promise<void>,
    reauthorize: boolean,
    authorizeUser: FeishuUserAuthorize,
  ): Promise<FeishuUserSession> {
    if (!reauthorize) {
      const current = await this.#usableUserToken(registration);
      const stored = await this.#userSession();
      if (current !== undefined && stored !== undefined && stored.client_id === registration.client_id) return stored;
    }
    const result = await authorizeUser({
      clientId: registration.client_id,
      clientSecret: registration.client_secret,
      scopes: feishuLibraryUserScopes,
      ...(registration.user_info?.tenant_brand === undefined ? {} : { tenantBrand: registration.user_info.tenant_brand }),
      onQRCodeReady: (info) => onQr(info.url, info.expireIn),
      fetch: this.#fetch,
      apiBase: this.#base,
      sleep: this.#sleep,
    });
    const session = sessionFromAuthorization(registration.client_id, result, this.#now());
    await this.#storeUser(session);
    return session;
  }

  async #createBase(
    registration: FeishuRegistration,
    state: FeishuLibraryState,
    identity: "user" | "tenant",
  ): Promise<FeishuLibraryState> {
    const data = await this.#api<{ app: { app_token: string; default_table_id: string; url: string } }>(
      registration,
      "POST",
      "/bitable/v1/apps",
      { name: "lumen 素材库" },
      identity,
    );
    const next: FeishuLibraryState = {
      ...state,
      appToken: required(data.app?.app_token, "a base token"),
      defaultTableId: required(data.app?.default_table_id, "a default table id"),
      url: required(data.app?.url, "a base link"),
    };
    await this.#save(next);
    return next;
  }

  async #listTables(registration: FeishuRegistration, appToken: string): Promise<Array<{ table_id: string; name: string }>> {
    return await this.#pages<{ table_id: string; name: string }>(registration, `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`);
  }

  async #listFields(registration: FeishuRegistration, appToken: string, tableId: string): Promise<readonly BitableField[]> {
    const items = await this.#pages<{ field_name?: string; type?: number; field_id?: string }>(
      registration,
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
    );
    return items.map((item) => {
      if (typeof item.field_name !== "string" || item.field_name.trim() === "" || typeof item.type !== "number") {
        throw new CliError("Feishu returned an incomplete field list");
      }
      const fieldId = typeof item.field_id === "string" && item.field_id.trim() !== "" ? item.field_id.trim() : undefined;
      return { field_name: item.field_name, type: item.type, ...(fieldId === undefined ? {} : { field_id: fieldId }) };
    });
  }

  async #pages<T>(registration: FeishuRegistration, requestPath: string): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "100", ...(pageToken === undefined ? {} : { page_token: pageToken }) });
      const result = await this.#api<{ items?: T[]; has_more?: boolean; page_token?: string }>(registration, "GET", `${requestPath}?${query}`);
      items.push(...(result.items ?? []));
      pageToken = result.has_more === true ? required(result.page_token, "a page token") : undefined;
    } while (pageToken !== undefined);
    return items;
  }

  async #findOrCreateLibraryTable(registration: FeishuRegistration, state: FeishuLibraryState): Promise<FeishuLibraryState> {
    const appToken = required(state.appToken, "a base token");
    const tables = await this.#listTables(registration, appToken);
    const existing = tables.find((item) => item.name === assetTableName);
    const created = existing?.table_id ?? (await this.#api<{ table_id: string }>(
      registration,
      "POST",
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
      { table: { name: assetTableName, default_view_name: "全部素材", fields: assetFields } },
    )).table_id;
    const next: FeishuLibraryState = { ...state, tableId: required(created, "a table id") };
    await this.#save(next);
    return next;
  }

  async #assertColumnsCompatible(registration: FeishuRegistration, appToken: string, tableId: string): Promise<void> {
    const present = await this.#listFields(registration, appToken, tableId);
    for (const expected of assetFields) {
      const found = present.find((item) => item.field_name === expected.field_name);
      if (found !== undefined && found.type !== expected.type) throw columnMismatch(expected.field_name, found.type, expected.type);
    }
  }

  async #ensureColumns(registration: FeishuRegistration, appToken: string, tableId: string): Promise<void> {
    const present = await this.#listFields(registration, appToken, tableId);
    for (const expected of assetFields) {
      const found = present.find((item) => item.field_name === expected.field_name);
      if (found === undefined) {
        await this.#api(
          registration,
          "POST",
          `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
          { field_name: expected.field_name, type: expected.type },
        );
        continue;
      }
      if (found.type !== expected.type) throw columnMismatch(expected.field_name, found.type, expected.type);
    }
  }

  async #grantEditor(registration: FeishuRegistration, state: FeishuLibraryState): Promise<FeishuLibraryState> {
    const appToken = required(state.appToken, "a base token");
    const openId = state.userOpenId ?? registration.user_info?.open_id;
    if (openId === undefined) throw new CliError("Feishu did not return a user id, so manageable access was not granted automatically");
    await this.#api(
      registration,
      "POST",
      `/drive/v1/permissions/${encodeURIComponent(appToken)}/members?type=bitable&need_notification=false`,
      { member_type: "openid", member_id: openId, perm: documentManagePermission, type: "user" },
    );
    const next: FeishuLibraryState = { ...state, userOpenId: openId, userCanEdit: true };
    await this.#save(next);
    return next;
  }

  async #ensureAdvancedRole(registration: FeishuRegistration, state: FeishuLibraryState): Promise<void> {
    const appToken = state.appToken;
    const tableId = state.tableId;
    if (appToken === undefined || tableId === undefined) return;
    try {
      const meta = await this.#api<{ app?: { is_advanced?: boolean } }>(registration, "GET", `/bitable/v1/apps/${encodeURIComponent(appToken)}`);
      if (meta.app?.is_advanced !== true) return;
      this.#advancedPermissionNote = advancedPermissionNote;
      const roles = await this.#pages<{ role_id?: string; role_name?: string; table_roles?: ReadonlyArray<{ table_id?: string; table_perm?: number }> }>(
        registration,
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/roles`,
      );
      const tableRole = { table_id: tableId, table_perm: editRecordsAndFields, allow_add_record: true, allow_delete_record: true };
      const existing = roles.find((role) => role.role_name === advancedEditorRole);
      let roleId = existing?.role_id;
      const covers = existing?.table_roles?.some((item) => item.table_id === tableId && item.table_perm === editRecordsAndFields) === true;
      if (roleId === undefined) {
        const created = await this.#api<{ role?: { role_id?: string } }>(
          registration,
          "POST",
          `/bitable/v1/apps/${encodeURIComponent(appToken)}/roles`,
          { role_name: advancedEditorRole, table_roles: [tableRole] },
        );
        roleId = created.role?.role_id;
      } else if (!covers) {
        await this.#api(
          registration,
          "PUT",
          `/bitable/v1/apps/${encodeURIComponent(appToken)}/roles/${encodeURIComponent(roleId)}`,
          { role_name: advancedEditorRole, table_roles: [tableRole] },
        );
      }
      const openId = state.userOpenId ?? registration.user_info?.open_id;
      if (roleId === undefined || openId === undefined) return;
      try {
        await this.#api(
          registration,
          "POST",
          `/bitable/v1/apps/${encodeURIComponent(appToken)}/roles/${encodeURIComponent(roleId)}/members?member_id_type=open_id`,
          { member_id: openId },
        );
      } catch {
        // The user may already be in the role.
      }
    } catch {
      // Connecting still succeeds when this base cannot be administered.
    }
  }

  async #probe(registration: FeishuRegistration, state: FeishuLibraryState): Promise<void> {
    await this.#api(
      registration,
      "GET",
      `/bitable/v1/apps/${encodeURIComponent(required(state.appToken, "a base token"))}/tables/${encodeURIComponent(required(state.tableId, "a table id"))}/records?page_size=1`,
    );
  }

  async #dropStarter(registration: FeishuRegistration, state: FeishuLibraryState): Promise<FeishuLibraryState> {
    const starterTable = state.defaultTableId;
    if (starterTable === undefined || starterTable === state.tableId) return state;
    try {
      await this.#api(registration, "DELETE", `/bitable/v1/apps/${encodeURIComponent(required(state.appToken, "a base token"))}/tables/${encodeURIComponent(starterTable)}`);
      const withoutStarter: FeishuLibraryState = {
        format: state.format,
        appId: state.appId,
        ...(state.appToken === undefined ? {} : { appToken: state.appToken }),
        ...(state.tableId === undefined ? {} : { tableId: state.tableId }),
        ...(state.url === undefined ? {} : { url: state.url }),
        ...(state.userOpenId === undefined ? {} : { userOpenId: state.userOpenId }),
        ...(state.userCanEdit === undefined ? {} : { userCanEdit: state.userCanEdit }),
      };
      await this.#save(withoutStarter);
      return withoutStarter;
    } catch {
      return state;
    }
  }

  async #wikiAppToken(registration: FeishuRegistration, wikiToken: string): Promise<string> {
    const data = await this.#api<{ node?: { obj_token?: string; obj_type?: string } }>(
      registration,
      "GET",
      `/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`,
    );
    if (data.node?.obj_type !== undefined && data.node.obj_type !== "bitable") {
      throw new CliError("That wiki link is not a base. Pass a /base/ link or --app-token.");
    }
    return required(data.node?.obj_token, "a base token");
  }

  async #configuredTenantScopes(registration: FeishuRegistration): Promise<{ readonly ok: true; readonly scopes: readonly string[] } | { readonly ok: false }> {
    const payloads: unknown[] = [];
    let ok = false;
    for (const requestPath of ["/application/v6/scopes", "/application/v6/applications/me?lang=en_us"]) {
      const read = await this.#readOpenPlatform(registration, requestPath);
      if (!read.ok) continue;
      ok = true;
      payloads.push(read.body);
    }
    if (!ok) return { ok: false };
    return { ok: true, scopes: tenantScopesFromOpenPlatform(...payloads) };
  }

  async #readOpenPlatform(registration: FeishuRegistration, requestPath: string): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false }> {
    try {
      const token = await this.#token(registration);
      const response = await this.#fetch(`${this.#base}${requestPath}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      const body: unknown = await response.json();
      const code = asRecord(body)?.code;
      if (!response.ok || (typeof code === "number" && code !== 0)) return { ok: false };
      return { ok: true, body };
    } catch {
      return { ok: false };
    }
  }

  async #adoptExisting(
    registration: FeishuRegistration,
    state: FeishuLibraryState,
    choice: Extract<FeishuBaseChoice, { action: "existing" }>,
  ): Promise<FeishuLibraryState> {
    const target = resolvedBindTarget(choice);
    let appToken = target.appToken;
    let tableId = target.tableId;
    if (target.wikiToken !== undefined) appToken = await this.#wikiAppToken(registration, target.wikiToken);
    if (appToken === undefined) throw missingBaseChoice();
    const tables = await this.#listTables(registration, appToken);
    if (tableId !== undefined) {
      if (!tables.some((item) => item.table_id === tableId)) throw new CliError("That table is not in this base");
    } else {
      tableId = tables.find((item) => item.name === assetTableName)?.table_id;
    }
    if (tableId !== undefined) await this.#assertColumnsCompatible(registration, appToken, tableId);
    let next: FeishuLibraryState = {
      ...state,
      appToken,
      ...(tableId === undefined ? {} : { tableId }),
      ...(target.url === undefined ? {} : { url: target.url }),
    };
    await this.#save(next);
    if (next.tableId === undefined) next = await this.#findOrCreateLibraryTable(registration, next);
    await this.#ensureColumns(registration, required(next.appToken, "a base token"), required(next.tableId, "a table id"));
    return next;
  }

  async #finishConnected(registration: FeishuRegistration, state: FeishuLibraryState): Promise<FeishuLibraryState> {
    if (state.userCanEdit !== true) {
      try {
        state = await this.#grantEditor(registration, state);
      } catch (error) {
        const session = await this.#userSession();
        if (session?.client_id !== registration.client_id) throw error;
      }
    }
    await this.#ensureAdvancedRole(registration, state);
    await this.#probe(registration, state);
    if (state.userCanEdit !== true) {
      state = { ...state, userCanEdit: true };
      await this.#save(state);
    }
    return await this.#dropStarter(registration, state);
  }

  async #listUserBases(registration: FeishuRegistration): Promise<readonly FeishuDriveBase[]> {
    const found: FeishuDriveBase[] = [];
    const seen = new Set<string>();
    const queue: Array<{ token?: string; depth: number }> = [{ depth: 0 }];
    let listed = 0;
    while (queue.length > 0 && found.length < 40 && listed < 25) {
      const current = queue.shift();
      if (current === undefined) break;
      listed += 1;
      let page: string | undefined;
      try {
        do {
          const query = new URLSearchParams({
            page_size: "200",
            ...(current.token === undefined ? {} : { folder_token: current.token }),
            ...(page === undefined ? {} : { page_token: page }),
          });
          const result = await this.#api<{
            files?: ReadonlyArray<{ token?: string; name?: string; type?: string; url?: string }>;
            has_more?: boolean;
            page_token?: string;
            next_page_token?: string;
          }>(registration, "GET", `/drive/v1/files?${query}`, undefined, "user");
          for (const file of result.files ?? []) {
            if (typeof file.token !== "string" || file.token === "" || seen.has(file.token)) continue;
            seen.add(file.token);
            if (file.type === "bitable") {
              const name = typeof file.name === "string" ? file.name.trim() : "";
              found.push({
                token: file.token,
                name: name === "" ? "Untitled base" : name,
                ...(typeof file.url === "string" && file.url !== "" ? { url: file.url } : {}),
              });
            } else if (file.type === "folder" && current.depth < 1 && queue.length < 20) {
              queue.push({ token: file.token, depth: current.depth + 1 });
            }
          }
          const next = result.next_page_token ?? result.page_token;
          page = result.has_more === true && typeof next === "string" && next !== "" ? next : undefined;
        } while (page !== undefined && found.length < 40);
      } catch (error) {
        if (current.depth === 0 && found.length === 0) throw error;
      }
    }
    return found;
  }

  async #token(registration: FeishuRegistration): Promise<string> {
    return await this.#bearer(registration, "tenant");
  }

  async #bearer(registration: FeishuRegistration, identity: "auto" | "user" | "tenant" = "auto"): Promise<string> {
    if (identity !== "tenant") {
      const user = await this.#usableUserToken(registration);
      if (user !== undefined) return user;
      if (identity === "user") throw new CliError("Feishu user login is missing or expired. Run: lumen library connect feishu");
    }
    if (this.#access !== undefined && this.#access.appId === registration.client_id && this.#access.expiresAt > this.#now() + 60_000) {
      return this.#access.value;
    }
    const response = await this.#fetch(`${this.#base}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: registration.client_id, app_secret: registration.client_secret }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || result.code !== 0) {
      throw new CliError(scrub(`Feishu tenant token failed (${result.code ?? response.status}): ${result.msg ?? "unknown error"}`, [registration.client_secret]));
    }
    const value = required(result.tenant_access_token, "a tenant token");
    this.#access = { value, expiresAt: this.#now() + Math.max(60, result.expire ?? 3600) * 1000, appId: registration.client_id };
    return value;
  }

  async #usableUserToken(registration: FeishuRegistration): Promise<string | undefined> {
    const session = await this.#userSession();
    if (session === undefined || session.client_id !== registration.client_id) return undefined;
    if (session.expires_at > this.#now() + 60_000) return session.access_token;
    const refreshed = await this.#refreshUser(registration, session);
    return refreshed?.access_token;
  }

  async #refreshUser(registration: FeishuRegistration, session: FeishuUserSession): Promise<FeishuUserSession | undefined> {
    if (session.refresh_token === undefined || session.refresh_token === "") return undefined;
    if (session.refresh_expires_at !== undefined && session.refresh_expires_at <= this.#now()) return undefined;
    try {
      const response = await this.#fetch(`${this.#base}/authen/v2/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: session.refresh_token,
          client_id: registration.client_id,
          client_secret: registration.client_secret,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) return undefined;
      const token = asRecord(payload);
      const access = token?.access_token;
      if (typeof access !== "string" || access === "") return undefined;
      const next = sessionFromAuthorization(registration.client_id, {
        access_token: access,
        expires_in: typeof token?.expires_in === "number" ? token.expires_in : 7200,
        ...(typeof token?.refresh_token === "string" ? { refresh_token: token.refresh_token } : {}),
        ...(typeof token?.refresh_token_expires_in === "number" ? { refresh_token_expires_in: token.refresh_token_expires_in } : {}),
        ...(typeof token?.open_id === "string" ? { open_id: token.open_id } : {}),
      }, this.#now(), session);
      await this.#storeUser(next);
      return next;
    } catch {
      return undefined;
    }
  }

  async #api<T>(
    registration: FeishuRegistration,
    method: string,
    requestPath: string,
    body?: unknown,
    identity: "auto" | "user" | "tenant" = "auto",
  ): Promise<T> {
    const token = await this.#bearer(registration, identity);
    const session = await this.#userSession();
    const response = await this.#fetch(`${this.#base}${requestPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json() as { code?: number; msg?: string; data?: T };
    if (!response.ok || result.code !== 0) {
      throw new CliError(scrub(
        `Feishu ${method} ${safeApiPath(requestPath)} failed (${result.code ?? response.status}): ${result.msg ?? "unknown error"}`,
        [registration.client_secret, token, session?.access_token, session?.refresh_token],
      ));
    }
    return result.data as T;
  }

  async #ready(): Promise<{ registration: FeishuRegistration; state: FeishuLibraryState }> {
    const registration = await this.#registration();
    const state = await this.#state();
    if (registration === undefined || state?.appToken === undefined || state.tableId === undefined || state.userCanEdit !== true) {
      throw new CliError("No Feishu asset library is selected. Run: lumen library connect feishu");
    }
    return { registration, state };
  }

  async #upload(registration: FeishuRegistration, state: FeishuLibraryState, filePath: string): Promise<{ token: string; hash: string }> {
    const info = await stat(filePath).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new CliError(`Reference file is missing: ${filePath}`);
    const bytes = await readFile(filePath);
    if (bytes.byteLength > 20 * 1024 * 1024) throw new CliError("Feishu attachments must be 20MB or smaller");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const appToken = required(state.appToken, "a base token");
    const form = new FormData();
    form.set("file_name", path.basename(filePath));
    form.set("parent_type", "bitable_file");
    form.set("parent_node", appToken);
    form.set("size", String(bytes.byteLength));
    form.set("extra", JSON.stringify({ drive_route_token: appToken }));
    form.set("file", new Blob([new Uint8Array(bytes)]), path.basename(filePath));
    const response = await this.#fetch(`${this.#base}/drive/v1/medias/upload_all`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.#bearer(registration)}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json() as { code?: number; msg?: string; data?: { file_token?: string } };
    if (!response.ok || result.code !== 0) {
      throw new CliError(scrub(`Feishu upload failed (${result.code ?? response.status}): ${result.msg ?? "unknown error"}`, [registration.client_secret]));
    }
    return { token: required(result.data?.file_token, "a file token"), hash };
  }

  async #create(fields: Record<string, unknown>, sourceFile?: string): Promise<FeishuLibraryRecord> {
    const { registration, state } = await this.#ready();
    const appToken = required(state.appToken, "a base token");
    const tableId = required(state.tableId, "a table id");
    if (sourceFile !== undefined) {
      const uploaded = await this.#upload(registration, state, sourceFile);
      fields["原始文件"] = [{ file_token: uploaded.token }];
      fields["文件指纹"] = uploaded.hash;
    }
    const result = await this.#api<{ record: FeishuLibraryRecord }>(
      registration,
      "POST",
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?client_token=${randomUUID()}`,
      { fields },
    );
    return result.record;
  }
}

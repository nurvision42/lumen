import { gzipSync } from "node:zlib";
import { CliError } from "../errors.js";

const registrationPath = "/oauth/v1/app/registration";
const deviceAuthorizationPath = "/oauth/v1/device_authorization";
const userTokenPath = "/authen/v2/oauth/token";

export type FeishuRegistration = {
  readonly client_id: string;
  readonly client_secret: string;
  readonly user_info?: { readonly open_id?: string; readonly tenant_brand?: string };
};

export type FeishuUserAuthorization = {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly refresh_token_expires_in?: number;
  readonly open_id?: string;
  readonly scope?: string;
};

export type FeishuAppRegistrationRequest = {
  readonly appId?: string;
  readonly createOnly?: boolean;
  readonly appPreset: { readonly name: string; readonly desc: string };
  readonly addons: {
    readonly preset: false;
    readonly scopes: { readonly tenant: readonly string[]; readonly user?: readonly string[] };
  };
  readonly onQRCodeReady: (info: { readonly url: string; readonly expireIn: number }) => void | Promise<void>;
};

export type FeishuUserAuthorize = (options: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly tenantBrand?: string;
  readonly onQRCodeReady: (info: { readonly url: string; readonly expireIn: number }) => void | Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBase?: string;
  readonly accountsBase?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}) => Promise<FeishuUserAuthorization>;

type RegistrationResponse = {
  readonly verification_uri_complete?: unknown;
  readonly device_code?: unknown;
  readonly expires_in?: unknown;
  readonly interval?: unknown;
  readonly client_id?: unknown;
  readonly client_secret?: unknown;
  readonly user_info?: { readonly open_id?: unknown; readonly tenant_brand?: unknown };
  readonly error?: unknown;
  readonly error_description?: unknown;
};

function scrub(message: string, secrets: readonly (string | undefined)[]): string {
  let text = message;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 8 || !text.includes(secret)) continue;
    text = text.split(secret).join("***");
  }
  return text;
}

async function pause(sleep: ((ms: number) => Promise<void>) | undefined, ms: number): Promise<void> {
  if (ms <= 0) return;
  if (sleep !== undefined) {
    await sleep(ms);
    return;
  }
  await new Promise((done) => setTimeout(done, ms));
}

function registrationText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError(`Feishu app registration did not return ${label}`);
  }
  return value;
}

function encodeAddons(addons: FeishuAppRegistrationRequest["addons"]): string {
  return gzipSync(Buffer.from(JSON.stringify(addons), "utf8")).toString("base64url");
}

async function requestRegistration(
  base: string,
  params: Record<string, string>,
  fetcher: typeof globalThis.fetch,
): Promise<RegistrationResponse> {
  const response = await fetcher(`${base}${registrationPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as RegistrationResponse;
  } catch {
    throw new CliError(`Feishu app registration returned an unreadable response (HTTP ${response.status})`);
  }
}

/**
 * Create or update one Feishu app by scanning a code.
 * The confirm page can create an app or choose an existing one unless `createOnly` is set.
 */
export async function registerFeishuApp(
  options: FeishuAppRegistrationRequest & {
    readonly fetch?: typeof globalThis.fetch;
    readonly registrationBase?: string;
    readonly larkRegistrationBase?: string;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<FeishuRegistration> {
  const fetcher = options.fetch ?? globalThis.fetch;
  let base = (options.registrationBase ?? "https://accounts.feishu.cn").replace(/\/+$/u, "");
  const larkBase = (options.larkRegistrationBase ?? "https://accounts.larksuite.com").replace(/\/+$/u, "");
  const begin = await requestRegistration(base, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  }, fetcher);
  const url = new URL(registrationText(begin.verification_uri_complete, "a confirmation URL"));
  url.searchParams.set("from", "sdk");
  url.searchParams.set("source", "lumen");
  url.searchParams.set("tp", "sdk");
  url.searchParams.set("name", options.appPreset.name);
  url.searchParams.set("desc", options.appPreset.desc);
  url.searchParams.set("addons", encodeAddons(options.addons));
  // Feishu's phone hides 绑定已有应用 when createOnly is present. The default scan
  // leaves it off, and drops it if the begin URL already set it, so the phone can
  // offer 新建应用 or 绑定已有应用. No App ID or App Secret is typed on that path.
  if (options.createOnly === true) url.searchParams.set("createOnly", "true");
  else url.searchParams.delete("createOnly");
  if (options.appId !== undefined && options.appId !== "") url.searchParams.set("clientID", options.appId);
  const expireIn = typeof begin.expires_in === "number" ? begin.expires_in : 600;
  await options.onQRCodeReady({ url: url.toString(), expireIn });

  const deviceCode = registrationText(begin.device_code, "a device code");
  let interval = (typeof begin.interval === "number" ? begin.interval : 5) * 1000;
  const deadline = Date.now() + expireIn * 1000;
  let switched = false;
  while (Date.now() < deadline) {
    const poll = await requestRegistration(base, { action: "poll", device_code: deviceCode }, fetcher);
    if (poll.user_info?.tenant_brand === "lark" && !switched) {
      base = larkBase;
      switched = true;
      continue;
    }
    if (typeof poll.client_id === "string" && typeof poll.client_secret === "string") {
      return {
        client_id: poll.client_id,
        client_secret: poll.client_secret,
        ...(poll.user_info === undefined ? {} : {
          user_info: {
            ...(typeof poll.user_info.open_id === "string" ? { open_id: poll.user_info.open_id } : {}),
            ...(typeof poll.user_info.tenant_brand === "string" ? { tenant_brand: poll.user_info.tenant_brand } : {}),
          },
        }),
      };
    }
    const failure = poll.error;
    if (failure === "access_denied" || failure === "expired_token") {
      throw new CliError(`Feishu confirmation was not finished (${String(failure)})`);
    }
    if (failure === "slow_down") interval += 5000;
    else if (failure !== undefined && failure !== "authorization_pending") {
      throw new CliError(`Feishu confirmation failed (${String(failure)})`);
    }
    await pause(options.sleep, interval);
  }
  throw new CliError("Feishu confirmation timed out. Run: lumen library connect feishu");
}

function oauthTokenFields(payload: Record<string, unknown>): FeishuUserAuthorization | undefined {
  const nested = payload["data"];
  const source = typeof payload["access_token"] === "string"
    ? payload
    : nested !== null && typeof nested === "object"
      ? nested as Record<string, unknown>
      : payload;
  const code = source["code"] ?? payload["code"];
  if (typeof code === "number" && code !== 0) return undefined;
  if (typeof source["error"] === "string" || typeof payload["error"] === "string") return undefined;
  const access = source["access_token"];
  if (typeof access !== "string" || access === "") return undefined;
  const refresh = source["refresh_token"];
  const expires = source["expires_in"];
  const refreshExpires = source["refresh_token_expires_in"];
  const scope = source["scope"];
  const openId = source["open_id"];
  return {
    access_token: access,
    ...(typeof refresh === "string" && refresh !== "" ? { refresh_token: refresh } : {}),
    expires_in: typeof expires === "number" ? expires : 7200,
    ...(typeof refreshExpires === "number" ? { refresh_token_expires_in: refreshExpires } : {}),
    ...(typeof openId === "string" && openId !== "" ? { open_id: openId } : {}),
    ...(typeof scope === "string" && scope !== "" ? { scope } : {}),
  };
}

async function postForm(
  fetcher: typeof globalThis.fetch,
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CliError(`Feishu user login returned an unreadable response (HTTP ${response.status})`);
  }
}

/** Sign in with Feishu's user device flow. The returned tokens are stored, never printed. */
export async function authorizeFeishuUser(options: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly tenantBrand?: string;
  readonly onQRCodeReady: (info: { readonly url: string; readonly expireIn: number }) => void | Promise<void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBase?: string;
  readonly accountsBase?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<FeishuUserAuthorization> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const lark = options.tenantBrand === "lark";
  const accounts = (options.accountsBase ?? (lark ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn")).replace(/\/+$/u, "");
  const api = (options.apiBase ?? (lark ? "https://open.larksuite.com/open-apis" : "https://open.feishu.cn/open-apis")).replace(/\/+$/u, "");
  const scopes = options.scopes.includes("offline_access") ? options.scopes : [...options.scopes, "offline_access"];
  const secret = options.clientSecret;
  const basic = Buffer.from(`${options.clientId}:${secret}`).toString("base64");
  let begin: Record<string, unknown>;
  try {
    begin = await postForm(fetcher, `${accounts}${deviceAuthorizationPath}`, {
      client_id: options.clientId,
      scope: scopes.join(" "),
    }, { authorization: `Basic ${basic}` });
  } catch (error) {
    throw new CliError(scrub(error instanceof Error ? error.message : String(error), [secret]));
  }
  const failure = begin["error"];
  if (typeof failure === "string" && failure !== "") {
    throw new CliError(scrub(`Feishu user login failed (${failure})`, [secret]));
  }
  const verify = begin["verification_uri_complete"] ?? begin["verification_uri"];
  if (typeof verify !== "string" || verify.trim() === "") throw new CliError("Feishu user login did not return a confirmation URL");
  const expireIn = typeof begin["expires_in"] === "number" ? begin["expires_in"] : 240;
  await options.onQRCodeReady({ url: verify, expireIn });
  const deviceCode = begin["device_code"];
  if (typeof deviceCode !== "string" || deviceCode === "") throw new CliError("Feishu user login did not return a device code");
  let interval = typeof begin["interval"] === "number" && begin["interval"] >= 0 ? begin["interval"] : 5;
  const deadline = Date.now() + expireIn * 1000;
  while (Date.now() < deadline) {
    const poll = await postForm(fetcher, `${api}${userTokenPath}`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: options.clientId,
      client_secret: secret,
    }, {});
    const token = oauthTokenFields(poll);
    if (token !== undefined) {
      let openId = token.open_id;
      if (openId === undefined) {
        try {
          const info = await fetcher(`${api}/authen/v1/user_info`, {
            headers: { authorization: `Bearer ${token.access_token}` },
            signal: AbortSignal.timeout(30_000),
          });
          const body = await info.json() as { data?: { open_id?: unknown } };
          if (typeof body.data?.open_id === "string" && body.data.open_id !== "") openId = body.data.open_id;
        } catch {
          // The table can still be chosen. Edit access is checked with a one-row read.
        }
      }
      return openId === undefined ? token : { ...token, open_id: openId };
    }
    const pollError = poll["error"];
    if (pollError === "authorization_pending") {
      await pause(options.sleep, interval * 1000);
      continue;
    }
    if (pollError === "slow_down") {
      interval += 5;
      await pause(options.sleep, interval * 1000);
      continue;
    }
    if (typeof pollError === "string" && pollError !== "") {
      throw new CliError(scrub(`Feishu user login failed (${pollError})`, [secret, deviceCode]));
    }
    const code = poll["code"];
    if (typeof code === "number" && code !== 0) {
      throw new CliError(scrub(`Feishu user login failed (${code})`, [secret, deviceCode]));
    }
    await pause(options.sleep, interval * 1000);
  }
  throw new CliError("Feishu user login timed out. Run: lumen library connect feishu");
}

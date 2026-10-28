import { gzipSync } from "node:zlib";
import { CliError } from "../errors.js";
import type { IO } from "../io.js";
import { hostsFor, REGISTRATION_BEGIN_URL, registrationPollUrl, type FeishuBrand } from "./endpoints.js";
import { asObject, numberField, oauthError, postForm, stringField } from "./http.js";
import { USER_SCOPES } from "./scopes.js";

export interface RegistrationChallenge {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface RegisteredApp {
  appId: string;
  appSecret: string;
  brand: FeishuBrand;
  openId?: string;
}

export function encodeAddons(scopes: readonly string[]): string {
  const body = JSON.stringify({ scopes: { user: [...scopes] } });
  return gzipSync(Buffer.from(body)).toString("base64url");
}

/** Verification page. The user can create an app or pick an existing one; scopes are prefilled. */
export function registrationPageUrl(rawUrl: string, scopes: readonly string[], options: { appId?: string; name?: string; desc?: string } = {}): string {
  const url = new URL(rawUrl);
  url.searchParams.set("from", "lumen");
  url.searchParams.set("source", "lumen");
  url.searchParams.set("addons", encodeAddons(scopes));
  if (options.name !== undefined && options.name.length > 0) url.searchParams.set("name", options.name);
  if (options.desc !== undefined && options.desc.length > 0) url.searchParams.set("desc", options.desc);
  if (options.appId !== undefined && options.appId.length > 0) url.searchParams.set("clientID", options.appId);
  return url.toString();
}

function failRegistration(json: unknown, status: number): void {
  const message = oauthError(json);
  if (message.length > 0 || status >= 400) throw new CliError(`Feishu app registration failed: ${message || `HTTP ${status}`}`);
}

export async function beginRegistration(io: IO, options: { appId?: string } = {}): Promise<RegistrationChallenge> {
  const response = await postForm(io, REGISTRATION_BEGIN_URL, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id tenant_brand",
  });
  const record = asObject(response.json);
  failRegistration(response.json, response.status);
  const deviceCode = stringField(record, "device_code");
  const userCode = stringField(record, "user_code");
  if (deviceCode.length === 0 || userCode.length === 0) throw new CliError("Feishu app registration returned no device code");
  const complete = stringField(record, "verification_uri_complete");
  const raw = complete.length > 0 ? complete : `${hostsFor("feishu").open}/page/cli?user_code=${encodeURIComponent(userCode)}`;
  let expiresIn = numberField(record, "expire_in", 0);
  if (expiresIn <= 0) expiresIn = numberField(record, "expires_in", 600);
  if (expiresIn <= 0) expiresIn = 600;
  let interval = numberField(record, "interval", 5);
  if (interval <= 0) interval = 5;
  return {
    deviceCode,
    userCode,
    verificationUrl: registrationPageUrl(raw, USER_SCOPES, {
      name: "lumen",
      desc: "lumen user drive",
      ...(options.appId === undefined ? {} : { appId: options.appId }),
    }),
    expiresIn,
    interval,
  };
}

export type PollStep = { kind: "pending" } | { kind: "slow_down"; interval: number } | { kind: "switch"; brand: FeishuBrand } | { kind: "ready"; app: RegisteredApp };

export async function pollRegistration(io: IO, brand: FeishuBrand, deviceCode: string): Promise<PollStep> {
  const response = await postForm(io, registrationPollUrl(brand), { action: "poll", device_code: deviceCode });
  const record = asObject(response.json) ?? {};
  const userInfo = asObject(record.user_info);
  const reported = stringField(userInfo, "tenant_brand");
  if (reported === "lark" && brand !== "lark") return { kind: "switch", brand: "lark" };
  const error = stringField(record, "error");
  if (error === "authorization_pending") return { kind: "pending" };
  if (error === "slow_down") return { kind: "slow_down", interval: 5 };
  if (error === "access_denied") throw new CliError("Feishu app registration was denied");
  if (error === "expired_token" || error === "invalid_grant") throw new CliError("Feishu app registration expired. Run lumen feishu setup again.");
  if (error.length > 0 || response.status >= 400) {
    throw new CliError(`Feishu app registration failed: ${oauthError(response.json) || error || `HTTP ${response.status}`}`);
  }
  const appId = stringField(record, "client_id");
  const appSecret = stringField(record, "client_secret");
  if (appId.length === 0 || appSecret.length === 0) return { kind: "pending" };
  const openId = stringField(userInfo, "open_id");
  return {
    kind: "ready",
    app: {
      appId,
      appSecret,
      brand: reported === "lark" ? "lark" : brand,
      ...(openId.length > 0 ? { openId } : {}),
    },
  };
}

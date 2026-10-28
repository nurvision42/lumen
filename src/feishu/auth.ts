import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { CliError } from "../errors.js";
import type { IO } from "../io.js";
import {
  authorizeUrl,
  callbackRedirectUri,
  deviceAuthorizationUrl,
  tokenUrl,
  type FeishuBrand,
} from "./endpoints.js";
import { asObject, numberField, oauthError, postForm, request, stringField } from "./http.js";
import { userScopeString } from "./scopes.js";
import { type FeishuApp, type FeishuSession } from "./store.js";

export const REFRESH_SKEW_MS = 60_000;

export interface UserToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
  tokenType: string;
}

export interface DeviceChallenge {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export function nowMs(io: IO): number {
  return (io.now ? io.now() : new Date()).getTime();
}

export function basicAuthorization(appId: string, appSecret: string): string {
  return `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`;
}

function tokenFrom(json: unknown): UserToken | undefined {
  const record = asObject(json);
  const nested = asObject(record?.data);
  const source = stringField(nested, "access_token").length > 0 ? nested : record;
  const accessToken = stringField(source, "access_token");
  if (accessToken.length === 0) return undefined;
  const refreshToken = stringField(source, "refresh_token");
  return {
    accessToken,
    refreshToken,
    expiresIn: numberField(source, "expires_in", 7200),
    refreshExpiresIn: numberField(source, "refresh_token_expires_in", 604800),
    scope: stringField(source, "scope"),
    tokenType: stringField(source, "token_type") || "Bearer",
  };
}

export async function beginDeviceLogin(io: IO, app: FeishuApp): Promise<DeviceChallenge> {
  const scope = userScopeString();
  const response = await postForm(
    io,
    deviceAuthorizationUrl(app.brand),
    { client_id: app.appId, scope },
    { authorization: basicAuthorization(app.appId, app.appSecret) },
    [app.appSecret],
  );
  const record = asObject(response.json);
  const error = oauthError(response.json);
  if (response.status >= 400 || error.length > 0) throw new CliError(`Feishu login failed: ${error || `HTTP ${response.status}`}`);
  const deviceCode = stringField(record, "device_code");
  if (deviceCode.length === 0) throw new CliError("Feishu login returned no device code");
  const verification = stringField(record, "verification_uri_complete") || stringField(record, "verification_uri");
  if (verification.length === 0) throw new CliError("Feishu login returned no verification URL");
  let interval = numberField(record, "interval", 5);
  if (interval <= 0) interval = 5;
  let expiresIn = numberField(record, "expires_in", 240);
  if (expiresIn <= 0) expiresIn = 240;
  return {
    deviceCode,
    userCode: stringField(record, "user_code"),
    verificationUrl: verification,
    expiresIn,
    interval,
  };
}

export type TokenPoll = { kind: "pending" } | { kind: "slow_down" } | { kind: "ready"; token: UserToken };

export async function pollDeviceToken(io: IO, app: FeishuApp, deviceCode: string): Promise<TokenPoll> {
  const response = await postForm(
    io,
    tokenUrl(app.brand),
    {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: app.appId,
      client_secret: app.appSecret,
    },
    {},
    [app.appSecret],
  );
  return classifyToken(response.status, response.json);
}

export async function exchangeAuthCode(io: IO, app: FeishuApp, code: string, redirectUri: string): Promise<UserToken> {
  const response = await postForm(
    io,
    tokenUrl(app.brand),
    {
      grant_type: "authorization_code",
      code,
      client_id: app.appId,
      client_secret: app.appSecret,
      redirect_uri: redirectUri,
    },
    {},
    [app.appSecret, code],
  );
  const step = classifyToken(response.status, response.json);
  if (step.kind !== "ready") throw new CliError("Feishu login did not return a user access token");
  if (step.token.refreshToken.length === 0) throw new CliError("Feishu login did not return a refresh token. Enable the offline_access user scope and try again.");
  return step.token;
}

export async function refreshToken(io: IO, app: FeishuApp, refresh: string): Promise<UserToken> {
  const response = await postForm(
    io,
    tokenUrl(app.brand),
    {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: app.appId,
      client_secret: app.appSecret,
    },
    {},
    [app.appSecret, refresh],
  );
  const step = classifyToken(response.status, response.json);
  if (step.kind !== "ready") throw new CliError("Feishu token refresh failed. Run lumen feishu login again.");
  if (step.token.refreshToken.length === 0) step.token.refreshToken = refresh;
  return step.token;
}

function classifyToken(status: number, json: unknown): TokenPoll {
  const record = asObject(json);
  const error = stringField(record, "error");
  if (error === "authorization_pending") return { kind: "pending" };
  if (error === "slow_down") return { kind: "slow_down" };
  if (error === "access_denied") throw new CliError("Feishu login was denied");
  if (error === "expired_token" || error === "invalid_grant") throw new CliError("Feishu login expired. Run lumen feishu login again.");
  const token = tokenFrom(json);
  if (token !== undefined && error.length === 0) return { kind: "ready", token };
  const code = record?.code;
  if (typeof code === "number" && code !== 0) {
    throw new CliError(`Feishu login failed: ${stringField(record, "msg") || stringField(record, "error_description") || String(code)}`);
  }
  if (status >= 400 || error.length > 0) throw new CliError(`Feishu login failed: ${oauthError(json) || `HTTP ${status}`}`);
  return { kind: "pending" };
}

export interface FeishuUser {
  openId?: string;
  unionId?: string;
  name?: string;
}

export async function fetchUser(io: IO, brand: FeishuBrand, accessToken: string): Promise<FeishuUser> {
  const response = await request(io, "GET", `${tokenHostOpen(brand)}/open-apis/authen/v1/user_info`, {
    headers: { authorization: `Bearer ${accessToken}` },
    secrets: [accessToken],
  });
  const data = asObject(asObject(response.json)?.data) ?? asObject(response.json);
  const openId = stringField(data, "open_id");
  const unionId = stringField(data, "union_id");
  const name = stringField(data, "name") || stringField(data, "en_name");
  return {
    ...(openId.length > 0 ? { openId } : {}),
    ...(unionId.length > 0 ? { unionId } : {}),
    ...(name.length > 0 ? { name } : {}),
  };
}

function tokenHostOpen(brand: FeishuBrand): string {
  return brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export function sessionFromToken(app: FeishuApp, token: UserToken, user: FeishuUser, now: number): FeishuSession {
  return {
    appId: app.appId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: now + token.expiresIn * 1000,
    refreshExpiresAt: now + token.refreshExpiresIn * 1000,
    scope: token.scope,
    tokenType: token.tokenType,
    ...(user.openId === undefined ? {} : { openId: user.openId }),
    ...(user.unionId === undefined ? {} : { unionId: user.unionId }),
    ...(user.name === undefined ? {} : { name: user.name }),
  };
}

export function callbackAuthorizeUrl(app: FeishuApp, port: number, state: string): { url: string; redirectUri: string } {
  const redirectUri = callbackRedirectUri(port);
  return { url: authorizeUrl(app.brand, app.appId, redirectUri, state, userScopeString()), redirectUri };
}

export function newOauthState(): string {
  return randomBytes(16).toString("hex");
}

export function waitForCallback(port: number, state: string, timeoutMs: number): { code: Promise<string>; listening: Promise<void> } {
  let resolveListening: () => void = () => undefined;
  let rejectListening: (error: Error) => void = () => undefined;
  const listening = new Promise<void>((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  const code = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const authCode = url.searchParams.get("code");
      const got = url.searchParams.get("state");
      res.statusCode = authCode !== null && got === state ? 200 : 400;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>lumen</title><p>Feishu authorization received. You can close this window.</p>");
      server.close();
      if (authCode === null || authCode.length === 0 || got !== state) {
        reject(new CliError("Feishu callback state did not match"));
        return;
      }
      resolve(authCode);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new CliError("Feishu callback timed out. Run lumen feishu login --callback again."));
    }, timeoutMs);
    const failListen = (error: Error): void => {
      clearTimeout(timer);
      rejectListening(error);
      reject(error);
    };
    server.on("error", (error) => {
      failListen(new CliError(`Feishu callback could not listen on 127.0.0.1:${port}: ${error.message}`));
    });
    server.listen(port, "127.0.0.1", () => {
      resolveListening();
      server.on("close", () => clearTimeout(timer));
    });
  });
  return { code, listening };
}

export async function sleep(io: IO, ms: number): Promise<void> {
  if (ms <= 0) return;
  if (io.sleep) {
    await io.sleep(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

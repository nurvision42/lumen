import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { flagList, flagString, parseFlags, requireRestEmpty, type FlagKind } from "../flags.js";
import { fail, line, type IO } from "../io.js";
import {
  beginDeviceLogin,
  callbackAuthorizeUrl,
  exchangeAuthCode,
  fetchUser,
  newOauthState,
  nowMs,
  pollDeviceToken,
  sessionFromToken,
  sleep,
  waitForCallback,
  type DeviceChallenge,
} from "../feishu/auth.js";
import { attachFile, createApp, createField, createRecord, createTable, createView, fieldBodies, fieldBody, listFields, listTables, parseJsonObject, parseJsonValue, parseViewType, searchRecords, setViewGroup, setViewSort, updateField, updateRecord, viewConfig } from "../feishu/bitable.js";
import { addComment, getPermission, grantMember, listComments, listMembers, updateShare, whiteboardNodes } from "../feishu/collab.js";
import { DEFAULT_CALLBACK_PORT } from "../feishu/endpoints.js";
import { createDoc, parseDocKind, readDoc, writeDoc } from "../feishu/docs.js";
import { createFolder, deleteItem, downloadDriveFile, listFolder, moveItem, searchDrive, uploadDriveFile } from "../feishu/drive.js";
import { beginRegistration, pollRegistration, type RegistrationChallenge } from "../feishu/register.js";
import { missingScopes, USER_SCOPE_SPECS } from "../feishu/scopes.js";
import { createSheet, readRange, sheetInfo, writeRange } from "../feishu/sheets.js";
import { clearSession, loadApp, readSession, readStoredApp, writeApp, writeSession, type FeishuApp } from "../feishu/store.js";
import { authorized } from "../feishu/user.js";
import { getNode, listNodes, listSpaces, searchWiki } from "../feishu/wiki.js";

const USAGE = `lumen feishu setup [--no-wait] [--device-code <code>] [--once] [--app-id <cli_>]
lumen feishu app
lumen feishu login [--no-wait] [--device-code <code>] [--once] [--callback] [--port 9753] [--redirect-uri <url>]
lumen feishu status
lumen feishu logout
lumen feishu scopes
lumen feishu search <keyword> [--type <type>] [--count <n>] [--offset <n>]
lumen feishu ls [folder]
lumen feishu upload --file <path> [--folder <token>] [--name <name>]
lumen feishu download --token <token> --to <path>
lumen feishu mkdir --name <name> [--folder <token>]
lumen feishu move --token <token> --type <type> --folder <token>
lumen feishu rm --token <token> --type <type> --yes
lumen feishu bitable tables|fields|records|create|update|attach|create-app|create-table|create-field|update-field|create-view|view-sort|view-group
lumen feishu doc get|create|write
lumen feishu sheet info|get|put|create
lumen feishu wiki spaces|ls|search|node
lumen feishu comment list|add
lumen feishu perm get|members|share|grant
lumen feishu board nodes --token <id>`;

export async function feishuCommand(args: string[], io: IO): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "setup":
      return setup(rest, io);
    case "app":
      return saveApp(rest, io);
    case "login":
      return login(rest, io);
    case "status":
      return status(rest, io);
    case "logout":
      return logout(rest, io);
    case "scopes":
      return scopes(rest, io);
    case "search":
      return search(rest, io);
    case "ls":
      return ls(rest, io);
    case "upload":
      return upload(rest, io);
    case "download":
      return download(rest, io);
    case "mkdir":
      return mkdirCommand(rest, io);
    case "move":
      return move(rest, io);
    case "rm":
      return remove(rest, io);
    case "bitable":
      return bitable(rest, io);
    case "doc":
      return doc(rest, io);
    case "sheet":
      return sheet(rest, io);
    case "wiki":
      return wiki(rest, io);
    case "comment":
      return comment(rest, io);
    case "perm":
      return perm(rest, io);
    case "board":
      return board(rest, io);
    default:
      throw new CliError(sub === undefined ? USAGE : `unknown feishu command: ${sub}\n\n${USAGE}`, 2);
  }
}

function printJson(io: IO, value: unknown): void {
  line(io, JSON.stringify(value));
}

function flags(args: string[], spec: Record<string, FlagKind>): { values: Record<string, string | boolean | string[] | undefined>; rest: string[] } {
  return parseFlags(args, spec);
}

function requiredFlag(values: Record<string, string | boolean | string[] | undefined>, name: string): string {
  const value = flagString(values, name);
  if (value === undefined) throw new CliError(`--${name} is required`, 2);
  return value;
}

function positive(values: Record<string, string | boolean | string[] | undefined>, name: string, fallback: number): number {
  const raw = flagString(values, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new CliError(`--${name} must be a positive integer`, 2);
  return value;
}

function boolFlag(values: Record<string, string | boolean | string[] | undefined>, name: string): boolean {
  return values[name] === true;
}

async function readJsonInput(values: Record<string, string | boolean | string[] | undefined>, name: string, fileFlag: string): Promise<unknown | undefined> {
  const inline = flagString(values, name);
  const file = flagString(values, fileFlag);
  if (inline !== undefined && file !== undefined) throw new CliError(`use one of --${name} or --${fileFlag}`, 2);
  if (file !== undefined) return parseJsonValue(await readFile(file, "utf8"), `--${fileFlag}`);
  if (inline !== undefined) return parseJsonValue(inline, `--${name}`);
  return undefined;
}

async function readTextInput(values: Record<string, string | boolean | string[] | undefined>, name: string, fileFlag: string): Promise<string> {
  const inline = flagString(values, name);
  const file = flagString(values, fileFlag);
  if (inline !== undefined && file !== undefined) throw new CliError(`use one of --${name} or --${fileFlag}`, 2);
  if (file !== undefined) return readFile(file, "utf8");
  if (inline !== undefined) return inline;
  throw new CliError(`--${name} is required`, 2);
}

function showLink(io: IO, message: string, url: string): void {
  fail(io, message);
  fail(io, url);
}

function pendingDevice(phase: "app" | "user", challenge: DeviceChallenge | RegistrationChallenge, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "pending",
    phase,
    deviceCode: challenge.deviceCode,
    userCode: challenge.userCode,
    verificationUrl: challenge.verificationUrl,
    expiresIn: challenge.expiresIn,
    interval: challenge.interval,
    ...extra,
  };
}

async function setup(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, { "no-wait": "boolean", once: "boolean", "device-code": "string", "app-id": "string" });
  requireRestEmpty(rest);
  const once = boolFlag(values, "once");
  const deviceCode = flagString(values, "device-code");
  const appId = flagString(values, "app-id");
  if (boolFlag(values, "no-wait") && deviceCode !== undefined) throw new CliError("use either --no-wait or --device-code", 2);
  let challenge: RegistrationChallenge;
  if (deviceCode === undefined) {
    challenge = await beginRegistration(io, appId === undefined ? {} : { appId });
    showLink(io, "Open this link in Feishu, or scan it as a QR code. Create an app or choose an existing one, then confirm the user permissions:", challenge.verificationUrl);
    if (boolFlag(values, "no-wait")) {
      printJson(io, pendingDevice("app", challenge));
      return 0;
    }
  } else {
    challenge = { deviceCode, userCode: "", verificationUrl: "", expiresIn: 600, interval: 5 };
  }
  const registered = await finishRegistration(io, challenge, once);
  if (registered === undefined) {
    printJson(io, { status: "pending", phase: "app", deviceCode: challenge.deviceCode });
    return 0;
  }
  const app: FeishuApp = { appId: registered.appId, appSecret: registered.appSecret, brand: registered.brand, source: "registration" };
  await writeApp(io.env, app);
  await clearSession(io.env);
  fail(io, `saved Feishu app ${app.appId}`);
  return startUserLogin(io, app, { once, noWait: once });
}

async function finishRegistration(io: IO, challenge: RegistrationChallenge, once: boolean): Promise<{ appId: string; appSecret: string; brand: FeishuApp["brand"] } | undefined> {
  let brand: FeishuApp["brand"] = "feishu";
  let interval = challenge.interval;
  const deadline = nowMs(io) + challenge.expiresIn * 1000;
  let wait = false;
  while (nowMs(io) < deadline) {
    if (wait) {
      if (once) return undefined;
      await sleep(io, interval * 1000);
    }
    wait = true;
    const step = await pollRegistration(io, brand, challenge.deviceCode);
    if (step.kind === "switch") {
      brand = step.brand;
      wait = false;
      continue;
    }
    if (step.kind === "slow_down") {
      interval += step.interval;
      continue;
    }
    if (step.kind === "ready") return step.app;
  }
  throw new CliError("Feishu app registration timed out. Run lumen feishu setup again.");
}

async function startUserLogin(io: IO, app: FeishuApp, options: { once: boolean; noWait: boolean }): Promise<number> {
  const challenge = await beginDeviceLogin(io, app);
  showLink(io, "Open this link in Feishu to grant your user account. One login covers the whole drive:", challenge.verificationUrl);
  if (options.noWait) {
    printJson(io, pendingDevice("user", challenge, { appId: app.appId }));
    return 0;
  }
  return finishUserLogin(io, app, challenge, options.once);
}

async function finishUserLogin(io: IO, app: FeishuApp, challenge: DeviceChallenge, once: boolean): Promise<number> {
  let interval = challenge.interval;
  const deadline = nowMs(io) + challenge.expiresIn * 1000;
  let wait = false;
  while (nowMs(io) < deadline) {
    if (wait) {
      if (once) {
        printJson(io, pendingDevice("user", challenge, { appId: app.appId }));
        return 0;
      }
      await sleep(io, interval * 1000);
    }
    wait = true;
    const step = await pollDeviceToken(io, app, challenge.deviceCode);
    if (step.kind === "slow_down") {
      interval += 5;
      continue;
    }
    if (step.kind === "pending") continue;
    return saveLogin(io, app, step.token);
  }
  throw new CliError("Feishu login timed out. Run lumen feishu login again.");
}

async function saveLogin(io: IO, app: FeishuApp, token: { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number; scope: string; tokenType: string }): Promise<number> {
  if (token.refreshToken.length === 0) throw new CliError("Feishu login did not return a refresh token. Enable the offline_access user scope and try again.");
  let user: { openId?: string; unionId?: string; name?: string } = {};
  try {
    user = await fetchUser(io, app.brand, token.accessToken);
  } catch {
    user = {};
  }
  const session = sessionFromToken(app, token, user, nowMs(io));
  await writeSession(io.env, session);
  const missing = missingScopes(session.scope);
  if (missing.length > 0) fail(io, `user token is missing ${missing.length} requested scopes. Publish the app version, then run lumen feishu login again.`);
  printJson(io, publicSession(app, session));
  return 0;
}

function publicSession(app: FeishuApp, session: { name?: string; openId?: string; expiresAt: number; refreshExpiresAt: number; scope: string }): Record<string, unknown> {
  return {
    loggedIn: true,
    appId: app.appId,
    appSource: app.source,
    brand: app.brand,
    name: session.name ?? "",
    openId: session.openId ?? "",
    expiresAt: new Date(session.expiresAt).toISOString(),
    refreshExpiresAt: new Date(session.refreshExpiresAt).toISOString(),
    scopes: session.scope.split(/\s+/).filter((item) => item.length > 0),
    missingScopes: missingScopes(session.scope),
  };
}

async function saveApp(args: string[], io: IO): Promise<number> {
  const { rest } = flags(args, {});
  requireRestEmpty(rest);
  const fromEnvId = io.env.FEISHU_APP_ID?.trim() ?? "";
  const fromEnvSecret = io.env.FEISHU_APP_SECRET?.trim() ?? "";
  let appId = fromEnvId;
  let appSecret = fromEnvSecret;
  if (appId.length === 0 || appSecret.length === 0) {
    appId = await ask(io, "Feishu App ID:", false);
    appSecret = await ask(io, "Feishu App Secret:", true);
  }
  if (appId.length === 0 || appSecret.length === 0) throw new CliError("Feishu App ID and App Secret are required");
  const previous = await readStoredApp(io.env);
  const app: FeishuApp = { appId, appSecret, brand: previous?.brand ?? "feishu", source: "manual" };
  if (io.env.FEISHU_BRAND?.trim()) app.brand = io.env.FEISHU_BRAND.trim().toLowerCase() === "lark" ? "lark" : "feishu";
  await writeApp(io.env, app);
  if (previous !== undefined && previous.appId !== app.appId) await clearSession(io.env);
  printJson(io, { ok: true, appId: app.appId, source: "manual", brand: app.brand });
  return 0;
}

async function login(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, {
    "no-wait": "boolean",
    once: "boolean",
    "device-code": "string",
    callback: "boolean",
    port: "string",
    "redirect-uri": "string",
  });
  requireRestEmpty(rest);
  const app = await loadApp(io.env);
  const deviceCode = flagString(values, "device-code");
  const callback = boolFlag(values, "callback");
  if (callback && deviceCode !== undefined) throw new CliError("use either --callback or --device-code", 2);
  if (callback && boolFlag(values, "no-wait")) throw new CliError("--callback waits for the browser redirect", 2);
  if (callback) return loginCallback(io, app, values);
  if (deviceCode !== undefined) {
    const challenge: DeviceChallenge = {
      deviceCode,
      userCode: "",
      verificationUrl: "",
      expiresIn: 600,
      interval: 5,
    };
    return finishUserLogin(io, app, challenge, boolFlag(values, "once"));
  }
  return startUserLogin(io, app, { once: boolFlag(values, "once"), noWait: boolFlag(values, "no-wait") || boolFlag(values, "once") });
}

async function loginCallback(io: IO, app: FeishuApp, values: Record<string, string | boolean | string[] | undefined>): Promise<number> {
  const port = positive(values, "port", DEFAULT_CALLBACK_PORT);
  const state = newOauthState();
  const built = callbackAuthorizeUrl(app, port, state);
  const redirectUri = flagString(values, "redirect-uri") ?? built.redirectUri;
  if (flagString(values, "redirect-uri") !== undefined && flagString(values, "redirect-uri") !== built.redirectUri) {
    throw new CliError(`--redirect-uri must be ${built.redirectUri} for --port ${port}`, 2);
  }
  const pending = waitForCallback(port, state, 5 * 60 * 1000);
  await pending.listening;
  showLink(io, "Open this link to grant your Feishu user. The redirect URL must be registered on the app:", built.url);
  const code = await pending.code;
  const token = await exchangeAuthCode(io, app, code, redirectUri);
  return saveLogin(io, app, token);
}

async function status(args: string[], io: IO): Promise<number> {
  const { rest } = flags(args, {});
  requireRestEmpty(rest);
  let app: FeishuApp | undefined;
  try {
    app = await loadApp(io.env);
  } catch {
    printJson(io, { loggedIn: false });
    return 0;
  }
  const session = await readSession(io.env);
  if (session === undefined || session.appId !== app.appId || nowMs(io) >= session.refreshExpiresAt) {
    printJson(io, { loggedIn: false, appId: app.appId, appSource: app.source, brand: app.brand });
    return 0;
  }
  printJson(io, publicSession(app, session));
  return 0;
}

async function logout(args: string[], io: IO): Promise<number> {
  const { rest } = flags(args, {});
  requireRestEmpty(rest);
  await clearSession(io.env);
  printJson(io, { ok: true });
  return 0;
}

async function scopes(args: string[], io: IO): Promise<number> {
  const { rest } = flags(args, {});
  requireRestEmpty(rest);
  printJson(io, { scopes: USER_SCOPE_SPECS });
  return 0;
}

async function search(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, { type: "string", count: "string", offset: "string" });
  const keyword = rest[0];
  if (keyword === undefined || rest.length !== 1) throw new CliError("lumen feishu search <keyword>", 2);
  const { client, app } = await authorized(io);
  const offsetRaw = flagString(values, "offset");
  const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
  if (!Number.isInteger(offset) || offset < 0) throw new CliError("--offset must be a non-negative integer", 2);
  printJson(io, await searchDrive(client, app.brand, keyword, {
    type: flagString(values, "type"),
    count: positive(values, "count", 20),
    offset,
  }));
  return 0;
}

async function ls(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, { "page-size": "string", "page-token": "string" });
  if (rest.length > 1) throw new CliError("lumen feishu ls [folder]", 2);
  const { client, app } = await authorized(io);
  printJson(io, await listFolder(client, app.brand, rest[0], {
    pageSize: positive(values, "page-size", 50),
    pageToken: flagString(values, "page-token"),
  }));
  return 0;
}

async function upload(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, { file: "string", folder: "string", name: "string" });
  requireRestEmpty(rest);
  const { client } = await authorized(io);
  const file = path.resolve(io.cwd, requiredFlag(values, "file"));
  printJson(io, await uploadDriveFile(client, file, { folderToken: flagString(values, "folder"), name: flagString(values, "name") }));
  return 0;
}

async function download(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, { token: "string", to: "string" });
  requireRestEmpty(rest);
  const { client } = await authorized(io);
  const dest = path.resolve(io.cwd, requiredFlag(values, "to"));
  printJson(io, await downloadDriveFile(client, requiredFlag(values, "token"), dest));
  return 0;
}

async function mkdirCommand(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, { name: "string", folder: "string" });
  requireRestEmpty(rest);
  const { client } = await authorized(io);
  printJson(io, await createFolder(client, requiredFlag(values, "name"), flagString(values, "folder")));
  return 0;
}

async function move(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, { token: "string", type: "string", folder: "string" });
  requireRestEmpty(rest);
  const { client } = await authorized(io);
  const record = await moveItem(client, requiredFlag(values, "token"), requiredFlag(values, "type"), requiredFlag(values, "folder"));
  printJson(io, { ok: record.code === 0 });
  return 0;
}

async function remove(args: string[], io: IO): Promise<number> {
  const { values, rest } = flags(args, { token: "string", type: "string", yes: "boolean" });
  requireRestEmpty(rest);
  if (!boolFlag(values, "yes")) throw new CliError("refusing to delete without --yes", 2);
  const { client } = await authorized(io);
  const record = await deleteItem(client, requiredFlag(values, "token"), requiredFlag(values, "type"));
  printJson(io, { ok: record.code === 0 });
  return 0;
}

async function bitable(args: string[], io: IO): Promise<number> {
  const [op, ...rest] = args;
  if (op === "tables") {
    const { values, rest: extra } = flags(rest, { app: "string", "page-token": "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await listTables(client, requiredFlag(values, "app"), flagString(values, "page-token")));
    return 0;
  }
  if (op === "fields") {
    const { values, rest: extra } = flags(rest, { app: "string", table: "string", "page-token": "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await listFields(client, requiredFlag(values, "app"), requiredFlag(values, "table"), flagString(values, "page-token")));
    return 0;
  }
  if (op === "records") {
    const { values, rest: extra } = flags(rest, { app: "string", table: "string", filter: "string", "filter-file": "string", "page-size": "string", "page-token": "string" });
    requireRestEmpty(extra);
    const filter = await readJsonInput(values, "filter", "filter-file");
    const { client } = await authorized(io);
    printJson(io, await searchRecords(client, requiredFlag(values, "app"), requiredFlag(values, "table"), {
      ...(filter === undefined ? {} : { filter }),
      pageSize: positive(values, "page-size", 100),
      pageToken: flagString(values, "page-token"),
    }));
    return 0;
  }
  if (op === "create" || op === "update") {
    const { values, rest: extra } = flags(rest, { app: "string", table: "string", record: "string", fields: "string", "fields-file": "string" });
    requireRestEmpty(extra);
    const fields = parseJsonObject(await readTextInput(values, "fields", "fields-file"), "--fields");
    const { client } = await authorized(io);
    const appToken = requiredFlag(values, "app");
    const table = requiredFlag(values, "table");
    printJson(io, op === "create" ? await createRecord(client, appToken, table, fields) : await updateRecord(client, appToken, table, requiredFlag(values, "record"), fields));
    return 0;
  }
  if (op === "attach") {
    const { values, rest: extra } = flags(rest, { app: "string", table: "string", record: "string", field: "string", file: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await attachFile(client, requiredFlag(values, "app"), requiredFlag(values, "table"), requiredFlag(values, "record"), requiredFlag(values, "field"), path.resolve(io.cwd, requiredFlag(values, "file"))));
    return 0;
  }
  if (op === "create-app") {
    const { values, rest: extra } = flags(rest, { name: "string", folder: "string" });
    requireRestEmpty(extra);
    const name = requiredFlag(values, "name");
    const folder = flagString(values, "folder");
    const { client, app } = await authorized(io);
    printJson(io, await createApp(client, name, folder, app.brand));
    return 0;
  }
  if (op === "create-table") {
    const { values, rest: extra } = flags(rest, { app: "string", name: "string", "view-name": "string", fields: "string", "fields-file": "string" });
    requireRestEmpty(extra);
    const viewName = flagString(values, "view-name");
    const fieldsRaw = await readJsonInput(values, "fields", "fields-file");
    if (viewName !== undefined && fieldsRaw === undefined) throw new CliError("--view-name requires --fields", 2);
    const fields = fieldsRaw === undefined ? undefined : fieldBodies(fieldsRaw, "--fields");
    const { client } = await authorized(io);
    printJson(io, await createTable(client, requiredFlag(values, "app"), requiredFlag(values, "name"), {
      ...(viewName === undefined ? {} : { viewName }),
      ...(fields === undefined ? {} : { fields }),
    }));
    return 0;
  }
  if (op === "create-field" || op === "update-field") {
    const spec: Record<string, FlagKind> = { ...FIELD_FLAGS, ...(op === "update-field" ? { "field-id": "string" as const } : {}) };
    const { values, rest: extra } = flags(rest, spec);
    requireRestEmpty(extra);
    const appToken = requiredFlag(values, "app");
    const table = requiredFlag(values, "table");
    if (op === "update-field") requiredFlag(values, "field-id");
    const body = await loadFieldBody(values);
    const { client } = await authorized(io);
    printJson(io, op === "create-field" ? await createField(client, appToken, table, body) : await updateField(client, appToken, table, requiredFlag(values, "field-id"), body));
    return 0;
  }
  if (op === "create-view") {
    const { values, rest: extra } = flags(rest, { app: "string", table: "string", name: "string", type: "string", sort: "string", "sort-file": "string", group: "string", "group-file": "string" });
    requireRestEmpty(extra);
    const sort = await readJsonInput(values, "sort", "sort-file");
    const group = await readJsonInput(values, "group", "group-file");
    if (sort !== undefined) viewConfig(sort, "sort");
    if (group !== undefined) viewConfig(group, "group");
    const viewType = parseViewType(flagString(values, "type"));
    const name = requiredFlag(values, "name");
    const { client } = await authorized(io);
    printJson(io, await createView(client, requiredFlag(values, "app"), requiredFlag(values, "table"), name, viewType, {
      ...(sort === undefined ? {} : { sort }),
      ...(group === undefined ? {} : { group }),
    }));
    return 0;
  }
  if (op === "view-sort" || op === "view-group") {
    const spec: Record<string, FlagKind> = {
      app: "string",
      table: "string",
      view: "string",
      ...(op === "view-sort" ? { sort: "string" as const, "sort-file": "string" as const } : { group: "string" as const, "group-file": "string" as const }),
    };
    const { values, rest: extra } = flags(rest, spec);
    requireRestEmpty(extra);
    const config = op === "view-sort" ? await readJsonInput(values, "sort", "sort-file") : await readJsonInput(values, "group", "group-file");
    if (config === undefined) throw new CliError(op === "view-sort" ? "--sort is required" : "--group is required", 2);
    viewConfig(config, op === "view-sort" ? "sort" : "group");
    const { client } = await authorized(io);
    const appToken = requiredFlag(values, "app");
    const table = requiredFlag(values, "table");
    const view = requiredFlag(values, "view");
    printJson(io, op === "view-sort" ? await setViewSort(client, appToken, table, view, config) : await setViewGroup(client, appToken, table, view, config));
    return 0;
  }
  throw new CliError("lumen feishu bitable tables|fields|records|create|update|attach|create-app|create-table|create-field|update-field|create-view|view-sort|view-group", 2);
}

const FIELD_FLAGS: Record<string, FlagKind> = {
  app: "string",
  table: "string",
  name: "string",
  type: "string",
  option: "list",
  formatter: "string",
  "link-table": "string",
  "back-field": "string",
  multiple: "boolean",
  field: "string",
  "field-file": "string",
};

async function loadFieldBody(values: Record<string, string | boolean | string[] | undefined>): Promise<Record<string, unknown>> {
  const raw = await readJsonInput(values, "field", "field-file");
  const named = ["name", "type", "formatter", "link-table", "back-field"];
  const hasFlag = named.some((name) => flagString(values, name) !== undefined) || flagList(values, "option").length > 0 || typeof values.multiple === "boolean";
  if (raw !== undefined) {
    if (hasFlag) throw new CliError("use either --field/--field-file or the field flags", 2);
    return fieldBody(raw, "--field");
  }
  const multiple = values.multiple;
  return fieldBody({
    name: requiredFlag(values, "name"),
    type: requiredFlag(values, "type"),
    ...(flagList(values, "option").length > 0 ? { options: flagList(values, "option") } : {}),
    ...(flagString(values, "formatter") !== undefined ? { formatter: flagString(values, "formatter") } : {}),
    ...(flagString(values, "link-table") !== undefined ? { linkTable: flagString(values, "link-table") } : {}),
    ...(flagString(values, "back-field") !== undefined ? { backField: flagString(values, "back-field") } : {}),
    ...(typeof multiple === "boolean" ? { multiple } : {}),
  }, "--field");
}

async function doc(args: string[], io: IO): Promise<number> {
  const [op, ...rest] = args;
  if (op === "get") {
    const { values, rest: extra } = flags(rest, { token: "string", kind: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await readDoc(client, requiredFlag(values, "token"), parseDocKind(flagString(values, "kind"))));
    return 0;
  }
  if (op === "create") {
    const { values, rest: extra } = flags(rest, { title: "string", folder: "string", kind: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await createDoc(client, parseDocKind(flagString(values, "kind")), requiredFlag(values, "title"), flagString(values, "folder")));
    return 0;
  }
  if (op === "write") {
    const { values, rest: extra } = flags(rest, { token: "string", text: "string", "text-file": "string", kind: "string", mode: "string" });
    requireRestEmpty(extra);
    const mode = flagString(values, "mode") ?? "append";
    if (mode !== "append" && mode !== "replace") throw new CliError("--mode must be append or replace", 2);
    const { client } = await authorized(io);
    printJson(io, await writeDoc(client, requiredFlag(values, "token"), parseDocKind(flagString(values, "kind")), await readTextInput(values, "text", "text-file"), mode));
    return 0;
  }
  throw new CliError("lumen feishu doc get|create|write", 2);
}

async function sheet(args: string[], io: IO): Promise<number> {
  const [op, ...rest] = args;
  if (op === "info") {
    const { values, rest: extra } = flags(rest, { token: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await sheetInfo(client, requiredFlag(values, "token")));
    return 0;
  }
  if (op === "get") {
    const { values, rest: extra } = flags(rest, { token: "string", range: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await readRange(client, requiredFlag(values, "token"), requiredFlag(values, "range")));
    return 0;
  }
  if (op === "put") {
    const { values, rest: extra } = flags(rest, { token: "string", range: "string", values: "string", "values-file": "string" });
    requireRestEmpty(extra);
    const rows = await readJsonInput(values, "values", "values-file");
    const { client } = await authorized(io);
    printJson(io, await writeRange(client, requiredFlag(values, "token"), requiredFlag(values, "range"), rows));
    return 0;
  }
  if (op === "create") {
    const { values, rest: extra } = flags(rest, { title: "string", folder: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await createSheet(client, requiredFlag(values, "title"), flagString(values, "folder")));
    return 0;
  }
  throw new CliError("lumen feishu sheet info|get|put|create", 2);
}

async function wiki(args: string[], io: IO): Promise<number> {
  const [op, ...rest] = args;
  if (op === "spaces") {
    const { values, rest: extra } = flags(rest, { "page-token": "string" });
    requireRestEmpty(extra);
    const { client, app } = await authorized(io);
    printJson(io, await listSpaces(client, flagString(values, "page-token"), app.brand === "lark" ? "en" : "zh"));
    return 0;
  }
  if (op === "ls") {
    const { values, rest: extra } = flags(rest, { space: "string", parent: "string", "page-token": "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await listNodes(client, requiredFlag(values, "space"), flagString(values, "parent"), flagString(values, "page-token")));
    return 0;
  }
  if (op === "search") {
    const { values, rest: extra } = flags(rest, { space: "string", "page-token": "string" });
    if (extra.length !== 1 || extra[0] === undefined) throw new CliError("lumen feishu wiki search <keyword>", 2);
    const { client, app } = await authorized(io);
    printJson(io, await searchWiki(client, app.brand, extra[0], flagString(values, "space"), flagString(values, "page-token")));
    return 0;
  }
  if (op === "node") {
    const { values, rest: extra } = flags(rest, { token: "string" });
    requireRestEmpty(extra);
    const { client, app } = await authorized(io);
    printJson(io, await getNode(client, requiredFlag(values, "token"), app.brand));
    return 0;
  }
  throw new CliError("lumen feishu wiki spaces|ls|search|node", 2);
}

async function comment(args: string[], io: IO): Promise<number> {
  const [op, ...rest] = args;
  if (op === "list") {
    const { values, rest: extra } = flags(rest, { token: "string", type: "string", "page-token": "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await listComments(client, requiredFlag(values, "token"), requiredFlag(values, "type"), flagString(values, "page-token")));
    return 0;
  }
  if (op === "add") {
    const { values, rest: extra } = flags(rest, { token: "string", type: "string", text: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await addComment(client, requiredFlag(values, "token"), requiredFlag(values, "type"), requiredFlag(values, "text")));
    return 0;
  }
  throw new CliError("lumen feishu comment list|add", 2);
}

async function perm(args: string[], io: IO): Promise<number> {
  const [op, ...rest] = args;
  if (op === "get") {
    const { values, rest: extra } = flags(rest, { token: "string", type: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await getPermission(client, requiredFlag(values, "token"), requiredFlag(values, "type")));
    return 0;
  }
  if (op === "members") {
    const { values, rest: extra } = flags(rest, { token: "string", type: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await listMembers(client, requiredFlag(values, "token"), requiredFlag(values, "type")));
    return 0;
  }
  if (op === "share") {
    const { values, rest: extra } = flags(rest, { token: "string", type: "string", link: "string", yes: "boolean" });
    requireRestEmpty(extra);
    if (!boolFlag(values, "yes")) throw new CliError("refusing to change sharing without --yes", 2);
    const linkShare = requiredFlag(values, "link");
    const allowed = ["closed", "tenant_readable", "tenant_editable", "anyone_readable", "anyone_editable"];
    if (!allowed.includes(linkShare)) throw new CliError(`--link must be one of ${allowed.join(", ")}`, 2);
    const { client } = await authorized(io);
    printJson(io, await updateShare(client, requiredFlag(values, "token"), requiredFlag(values, "type"), linkShare));
    return 0;
  }
  if (op === "grant") {
    const { values, rest: extra } = flags(rest, { token: "string", type: "string", member: "string", "member-type": "string", perm: "string" });
    requireRestEmpty(extra);
    const { client } = await authorized(io);
    printJson(io, await grantMember(client, requiredFlag(values, "token"), requiredFlag(values, "type"), requiredFlag(values, "member"), requiredFlag(values, "member-type"), requiredFlag(values, "perm")));
    return 0;
  }
  throw new CliError("lumen feishu perm get|members|share|grant", 2);
}

async function board(args: string[], io: IO): Promise<number> {
  const [op, ...rest] = args;
  if (op !== "nodes") throw new CliError("lumen feishu board nodes --token <id>", 2);
  const { values, rest: extra } = flags(rest, { token: "string" });
  requireRestEmpty(extra);
  const { client } = await authorized(io);
  printJson(io, await whiteboardNodes(client, requiredFlag(values, "token")));
  return 0;
}

async function ask(io: IO, label: string, secret: boolean): Promise<string> {
  fail(io, label);
  if (io.readLine !== undefined) return (await io.readLine()).trim();
  if (secret) return readSecret(io);
  if (!process.stdin.isTTY) throw new CliError("lumen feishu app needs a terminal, or set FEISHU_APP_ID and FEISHU_APP_SECRET");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
  }
}

async function readSecret(io: IO): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || stdin.setRawMode === undefined) {
    throw new CliError("lumen feishu app needs a terminal, or set FEISHU_APP_ID and FEISHU_APP_SECRET");
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let text = "";
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          cleanup();
          reject(new CliError("setup cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          fail(io, "");
          resolve(text.trim());
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          text = text.slice(0, -1);
          continue;
        }
        text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

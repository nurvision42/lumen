import path from "node:path";
import { CliError } from "../errors.js";
import { FeishuLibrary } from "../library/feishu.js";
import { connectedPayload, emitLibrary, injectedFetch, runExistingBind, runScanConnect, showFeishuQr } from "../library/session.js";
import { requireLumenHome } from "../library/store.js";
import { flagString, parseFlags, requireRestEmpty, type FlagKind } from "../flags.js";
import { line, type IO } from "../io.js";

function libraryOf(io: IO): FeishuLibrary {
  return new FeishuLibrary({ home: requireLumenHome(io.env), fetch: injectedFetch(io.fetch), sleep: io.sleep, now: io.now === undefined ? undefined : () => io.now!().getTime() });
}

function flags(args: string[], spec: Record<string, FlagKind>): { values: Record<string, string | boolean | string[] | undefined>; rest: string[] } {
  return parseFlags(args, spec);
}

export function libraryHelp(): string {
  return `lumen library status
lumen library connect feishu [--reauthorize] [--create]
lumen library list
lumen library find <name> [--type <type>]
lumen library add --name <name> --type <type> [--person <name>] [--provider <id>] [--account <id>] [--external-id <id>] [--file <path>] [--note <text>]
lumen library clone-voice

Default path: lumen library connect feishu
  Writes a Feishu app-authorization QR image and prints its path as qr: <file>.
  Attach that PNG in chat. The user scans it with the Feishu phone app.
  The phone shows 新建应用 or 绑定已有应用. No App ID or App Secret is typed.
  A later step: user line is the sign-in QR. Attach that image too.
  Then type a base number, link, app token, or create.
  --create skips the prompt. A base is not created unless you choose create.
  No browser page is opened, and the QR is not drawn in the terminal.

Optional, only when an App ID and App Secret are already known:
  lumen library connect feishu --existing
  lumen library connect feishu --app-id <id> --app-secret <secret> [--base-url <url> | --app-token <token>] [--table-id <id>]
  lumen library connect feishu --app-id <id> --app-secret <secret> --create
Binding an app that is already on the phone does not use these flags.
An existing base only gains missing columns. A second base is not created unless --create is set.
Secrets stay in the lumen credential directory and are not printed.
clone-voice is not wired yet: clone with lumen fish clone, then register the id with library add.`;
}

export async function libraryCommand(args: string[], io: IO): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "help") {
    line(io, libraryHelp());
    return 0;
  }
  if (sub === "status") return statusCommand(rest, io);
  if (sub === "connect") return connectCommand(rest, io);
  if (sub === "list") return listCommand(rest, io);
  if (sub === "find") return findCommand(rest, io);
  if (sub === "add") return addCommand(rest, io);
  if (sub === "clone-voice") return cloneVoiceCommand(rest);
  throw new CliError(`unknown library command: ${sub}\n\n${libraryHelp()}`, 2);
}

async function statusCommand(args: string[], io: IO): Promise<number> {
  requireRestEmpty(flags(args, {}).rest);
  const library = libraryOf(io);
  await emitLibrary(io, library, await library.status());
  return 0;
}

async function connectCommand(args: string[], io: IO): Promise<number> {
  const [provider, ...rest] = args;
  if (provider !== "feishu") throw new CliError(`library connect needs feishu\n\n${libraryHelp()}`, 2);
  const parsed = flags(rest, {
    reauthorize: "boolean",
    existing: "boolean",
    create: "boolean",
    "app-id": "string",
    "app-secret": "string",
    "base-url": "string",
    "app-token": "string",
    "table-id": "string",
  });
  requireRestEmpty(parsed.rest);
  const reauthorize = parsed.values.reauthorize === true;
  const existing = parsed.values.existing === true;
  const create = parsed.values.create === true;
  const appId = flagString(parsed.values, "app-id");
  const appSecret = flagString(parsed.values, "app-secret");
  const baseUrl = flagString(parsed.values, "base-url");
  const appToken = flagString(parsed.values, "app-token");
  const tableId = flagString(parsed.values, "table-id");
  const hasBase = [baseUrl, appToken, tableId].some((item) => item !== undefined);
  const binding = existing || [appId, appSecret, baseUrl, appToken, tableId].some((item) => item !== undefined);
  if (reauthorize && binding) {
    throw new CliError("--reauthorize refreshes the app already connected on this machine. To use another app, drop --reauthorize and pass --existing or --app-id.", 2);
  }
  if (existing && (create || [appId, appSecret, baseUrl, appToken, tableId].some((item) => item !== undefined))) {
    throw new CliError("--existing prompts for the App ID and App Secret. For a script, pass --app-id and --app-secret instead.", 2);
  }
  const library = libraryOf(io);
  if (existing) {
    await runExistingBind(io, library);
    return 0;
  }
  if (binding) {
    if (appId === undefined || appSecret === undefined) {
      throw new CliError("These flags need --app-id and --app-secret, or --existing to prompt for them. To create or bind an app from the phone, run: lumen library connect feishu", 2);
    }
    if (create && hasBase) throw new CliError("A base was already given. Drop --create. lumen will not create a second base.", 2);
    if (!create && !hasBase) throw missingBase();
    if (create) {
      await runCreateBind(io, library, appId, appSecret);
      return 0;
    }
    const state = await library.bind({
      clientId: appId,
      clientSecret: appSecret,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(appToken === undefined ? {} : { appToken }),
      ...(tableId === undefined ? {} : { tableId }),
    });
    await emitLibrary(io, library, connectedPayload(library, state));
    return 0;
  }
  await runScanConnect(io, library, reauthorize, create);
  return 0;
}

function missingBase(): CliError {
  return new CliError("Pass --base-url, --app-token, or --table-id to use an existing base, or pass --create to make one. A base is not created automatically.", 2);
}

async function runCreateBind(io: IO, library: FeishuLibrary, appId: string, appSecret: string): Promise<void> {
  const state = await library.bind({
    clientId: appId,
    clientSecret: appSecret,
    create: true,
    onUserQr: (url, expireIn) => showFeishuQr(io, "user", url, expireIn),
  });
  await emitLibrary(io, library, connectedPayload(library, state));
}

async function listCommand(args: string[], io: IO): Promise<number> {
  requireRestEmpty(flags(args, {}).rest);
  const library = libraryOf(io);
  await emitLibrary(io, library, { records: await library.records() });
  return 0;
}

async function findCommand(args: string[], io: IO): Promise<number> {
  const parsed = flags(args, { type: "string" });
  const name = parsed.rest[0];
  if (name === undefined) throw new CliError("Usage: lumen library find <name> [--type <type>]", 2);
  requireRestEmpty(parsed.rest.slice(1));
  const library = libraryOf(io);
  const type = flagString(parsed.values, "type");
  await emitLibrary(io, library, { records: await library.find(name, type) });
  return 0;
}

async function addCommand(args: string[], io: IO): Promise<number> {
  const parsed = flags(args, {
    name: "string",
    type: "string",
    person: "string",
    provider: "string",
    account: "string",
    "external-id": "string",
    file: "string",
    note: "string",
  });
  requireRestEmpty(parsed.rest);
  const name = flagString(parsed.values, "name");
  const type = flagString(parsed.values, "type");
  if (name === undefined || type === undefined) throw new CliError("Usage: lumen library add --name <name> --type <type>", 2);
  const file = flagString(parsed.values, "file");
  const library = libraryOf(io);
  const record = await library.add({
    name,
    type,
    ...(flagString(parsed.values, "person") === undefined ? {} : { person: flagString(parsed.values, "person") }),
    ...(flagString(parsed.values, "provider") === undefined ? {} : { provider: flagString(parsed.values, "provider") }),
    ...(flagString(parsed.values, "account") === undefined ? {} : { account: flagString(parsed.values, "account") }),
    ...(flagString(parsed.values, "external-id") === undefined ? {} : { externalId: flagString(parsed.values, "external-id") }),
    ...(flagString(parsed.values, "note") === undefined ? {} : { note: flagString(parsed.values, "note") }),
    ...(file === undefined ? {} : { sourceFile: path.resolve(io.cwd, file) }),
  });
  await emitLibrary(io, library, { record });
  return 0;
}

function cloneVoiceCommand(_args: string[]): number {
  throw new CliError(
    "library clone-voice is not wired yet. Clone with: lumen fish clone. Then register the provider id with: lumen library add --name <name> --type 音色 --provider kitta --account <account> --external-id <id> --file <recording>",
  );
}

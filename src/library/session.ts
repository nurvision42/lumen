import { createInterface } from "node:readline";
import { CliError } from "../errors.js";
import type { IO } from "../io.js";
import { line } from "../io.js";
import { redactText } from "../redact.js";
import { redactedTableUrl, type FeishuBaseChoice, type FeishuDriveBase, type FeishuLibrary } from "./feishu.js";
import { authorizeFeishuUser, registerFeishuApp } from "./oauth.js";
import { writeFeishuQr } from "./qrfile.js";
import { requireLumenHome } from "./store.js";

/** IO injects a string-only fetch. Open API calls pass string URLs. */
export function injectedFetch(fetchImpl: IO["fetch"]): typeof globalThis.fetch | undefined {
  if (fetchImpl === undefined) return undefined;
  return (input, init) => {
    if (typeof input === "string") return fetchImpl(input, init);
    if (input instanceof URL) return fetchImpl(input.href, init);
    return fetchImpl(input.url, init);
  };
}

export async function emitLibrary(io: IO, library: FeishuLibrary, payload: unknown): Promise<void> {
  const secrets = await library.secretValues();
  line(io, redactText(JSON.stringify(payload), secrets));
}

export function connectedPayload(library: FeishuLibrary, state: { readonly url?: string; readonly tableId?: string }): Record<string, unknown> {
  const note = library.advancedPermissionNote();
  return {
    connected: true,
    ...(state.tableId === undefined ? {} : { tableId: state.tableId }),
    url: redactedTableUrl(state.url) ?? null,
    ...(note === undefined ? {} : { note }),
  };
}

function readLine(io: IO): Promise<string> {
  if (io.readLine !== undefined) return io.readLine();
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    const timer = setTimeout(() => {
      rl.close();
      reject(new CliError("Timed out waiting for a reply. Run: lumen library connect feishu"));
    }, 10 * 60_000);
    rl.once("line", (value) => {
      clearTimeout(timer);
      rl.close();
      resolve(value);
    });
  });
}

/** Write the Feishu QR and print `qr: <path>`. The phone, not this process, shows the choice. */
export async function showFeishuQr(io: IO, kind: "app" | "user", url: string, expireIn: number): Promise<void> {
  const file = await writeFeishuQr(requireLumenHome(io.env), kind, url);
  line(io, `step: ${kind}`);
  line(io, `qr: ${file}`);
  line(io, `confirm: ${url}`);
  if (kind === "app") {
    line(io, `Attach this image in chat. The user scans it with the Feishu phone app. The phone shows 新建应用 or 绑定已有应用. No App ID or App Secret. Expires in about ${expireIn} seconds.`);
  } else {
    line(io, `Attach this image in chat. The same person scans it to sign in. Expires in about ${expireIn} seconds.`);
  }
}

function parseTarget(answer: string): FeishuBaseChoice {
  const text = answer.trim();
  if (text.toLowerCase() === "create") return { action: "create" };
  const parts = text.split(/\s+/u).filter((part) => part.length > 0);
  const first = parts[0];
  if (first === undefined) {
    throw new CliError("No base selected. Type a number, a base link, an app token, or create. A base is not created automatically.");
  }
  const tableId = parts[1];
  if (first.startsWith("http://") || first.startsWith("https://")) {
    return { action: "existing", baseUrl: first, ...(tableId === undefined ? {} : { tableId }) };
  }
  return { action: "existing", appToken: first, ...(tableId === undefined ? {} : { tableId }) };
}

async function chooseFromPrompt(io: IO, bases: readonly FeishuDriveBase[]): Promise<FeishuBaseChoice> {
  line(io, "bases:");
  bases.forEach((base, index) => {
    line(io, `${index + 1}. ${base.name}`);
  });
  line(io, "Type a number, a base link, an app token, or create. A base is not created unless you type create.");
  const answer = (await readLine(io)).trim();
  const picked = Number(answer);
  if (Number.isInteger(picked) && picked >= 1 && picked <= bases.length) {
    const base = bases[picked - 1];
    if (base === undefined) throw new CliError("That base is not in the list");
    return { action: "existing", appToken: base.token, ...(base.url === undefined ? {} : { baseUrl: base.url }) };
  }
  return parseTarget(answer);
}

/** Scan path: QR image on disk, then a typed base choice. No browser page. */
export async function runScanConnect(io: IO, library: FeishuLibrary, reauthorize: boolean, create: boolean): Promise<void> {
  let step = 0;
  const state = await library.connect(
    (request) => registerFeishuApp({ ...request, fetch: injectedFetch(io.fetch), sleep: io.sleep }),
    async (url, expireIn) => {
      step += 1;
      await showFeishuQr(io, step === 1 ? "app" : "user", url, expireIn);
    },
    reauthorize,
    create ? async () => ({ action: "create" }) : (bases) => chooseFromPrompt(io, bases),
    (request) => authorizeFeishuUser({ ...request, fetch: injectedFetch(io.fetch), sleep: io.sleep }),
  );
  await emitLibrary(io, library, connectedPayload(library, state));
}

/** Prompt for an app id and secret that are already known. The secret is not printed. */
export async function runExistingBind(io: IO, library: FeishuLibrary): Promise<void> {
  line(io, "App ID:");
  const appId = (await readLine(io)).trim();
  line(io, "App Secret:");
  const appSecret = (await readLine(io)).trim();
  line(io, "Base link, app token, or create:");
  const target = (await readLine(io)).trim();
  if (appId === "" || appSecret === "") throw new CliError("App ID and App Secret are required");
  const choice = parseTarget(target);
  if (choice.action === "create") {
    const state = await library.bind({
      clientId: appId,
      clientSecret: appSecret,
      create: true,
      onUserQr: (url, expireIn) => showFeishuQr(io, "user", url, expireIn),
    });
    await emitLibrary(io, library, connectedPayload(library, state));
    return;
  }
  const state = await library.bind({
    clientId: appId,
    clientSecret: appSecret,
    ...(choice.baseUrl === undefined ? {} : { baseUrl: choice.baseUrl }),
    ...(choice.appToken === undefined ? {} : { appToken: choice.appToken }),
    ...(choice.tableId === undefined ? {} : { tableId: choice.tableId }),
  });
  await emitLibrary(io, library, connectedPayload(library, state));
}

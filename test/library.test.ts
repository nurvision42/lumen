import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FeishuLibrary, parseFeishuBaseUrl } from "../src/library/feishu.js";
import { registerFeishuApp } from "../src/library/oauth.js";
import { assetFields } from "../src/library/schema.js";
import {
  feishuLibraryConnectScopes,
  feishuLibraryTenantScopes,
  feishuLibraryUserScopes,
  tenantScopesFromOpenPlatform,
} from "../src/library/scopes.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const secret = "super-secret-value";
const userToken = "user-access-token";
const refreshToken = "user-refresh-token";
const appToken = "bascnLibraryToken";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return { HOME: dir, PATH: process.env.PATH ?? "" };
}

function fieldItems(omit: readonly string[] = [], types: Record<string, number> = {}): Array<{ field_name: string; type: number; field_id: string }> {
  return assetFields
    .filter((field) => !omit.includes(field.field_name))
    .map((field) => ({ field_name: field.field_name, type: types[field.field_name] ?? field.type, field_id: `fld_${field.field_name}` }));
}

type Fake = {
  fetch: typeof globalThis.fetch;
  calls: Array<{ method: string; href: string; body: string }>;
  records: Array<{ record_id: string; fields: Record<string, unknown> }>;
  createdApps: () => number;
  grants: () => Array<Record<string, unknown>>;
};

function fakeFeishu(options: { omit?: readonly string[]; types?: Record<string, number>; scopes?: readonly string[]; libraryOnOther?: boolean } = {}): Fake {
  const calls: Fake["calls"] = [];
  const records: Fake["records"] = [];
  const grants: Array<Record<string, unknown>> = [];
  let createdApps = 0;
  let fields = fieldItems(options.omit ?? [], options.types ?? {});
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, href: url.href, body });
    if (url.pathname.endsWith("/oauth/v1/app/registration")) {
      if (body.includes("action=begin")) {
        return json({
          verification_uri_complete: "https://accounts.feishu.cn/oauth/verify?createOnly=true",
          device_code: "device-code-app",
          expires_in: 60,
          interval: 0,
        });
      }
      return json({ client_id: "cli_testapp", client_secret: secret, user_info: { open_id: "ou_admin" } });
    }
    if (url.pathname.endsWith("/oauth/v1/device_authorization")) {
      return json({
        verification_uri_complete: "https://accounts.feishu.cn/oauth/user",
        device_code: "device-code-user",
        expires_in: 60,
        interval: 0,
      });
    }
    if (url.pathname.endsWith("/authen/v2/oauth/token")) {
      return json({ access_token: userToken, refresh_token: refreshToken, expires_in: 7200, open_id: "ou_user" });
    }
    if (url.pathname.endsWith("/authen/v1/user_info")) return json({ data: { open_id: "ou_user" } });
    if (url.pathname.endsWith("/tenant_access_token/internal")) {
      return json({ code: 0, tenant_access_token: "tenant-token-value", expire: 7200 });
    }
    if (url.pathname.endsWith("/application/v6/scopes")) {
      const scopes = (options.scopes ?? []).map((scope_name) => ({ scope_name, grant_status: 1 }));
      return json({ code: 0, data: { scopes } });
    }
    if (url.pathname.includes("/drive/v1/files")) {
      return json({
        code: 0,
        data: {
          files: [
            { token: "fldFolder", name: "资料", type: "folder" },
            { token: appToken, name: "人物库", type: "bitable", url: `https://example.feishu.cn/base/${appToken}` },
          ],
          has_more: false,
        },
      });
    }
    if (method === "POST" && /\/bitable\/v1\/apps$/.test(url.pathname)) {
      createdApps += 1;
      return json({
        code: 0,
        data: { app: { app_token: "bascnCreated", default_table_id: "tblStarter", url: "https://example.feishu.cn/base/bascnCreated" } },
      });
    }
    if (method === "POST" && url.pathname.endsWith("/tables")) {
      return json({ code: 0, data: { table_id: "tblAsset01" } });
    }
    if (method === "GET" && url.pathname.endsWith("/tables")) {
      const items = url.pathname.includes("bascnCreated")
        ? []
        : url.pathname.includes("bascnOtherToken")
          ? options.libraryOnOther === true
            ? [{ table_id: "tblAsset01", name: "素材库" }]
            : [{ table_id: "tblOtherOnly", name: "别的表" }]
          : [{ table_id: "tblAsset01", name: "素材库" }];
      return json({ code: 0, data: { items, has_more: false } });
    }
    if (method === "GET" && url.pathname.endsWith("/fields")) return json({ code: 0, data: { items: fields, has_more: false } });
    if (method === "POST" && url.pathname.endsWith("/fields")) {
      const added = JSON.parse(body) as { field_name: string; type: number };
      fields = [...fields, { ...added, field_id: `fld_${added.field_name}` }];
      return json({ code: 0, data: added });
    }
    if (method === "GET" && /\/bitable\/v1\/apps\/[^/]+$/.test(url.pathname)) {
      return json({ code: 0, data: { app: { is_advanced: false } } });
    }
    if (method === "POST" && url.pathname.includes("/permissions/")) {
      grants.push(JSON.parse(body) as Record<string, unknown>);
      return json({ code: 0, data: {} });
    }
    if (method === "GET" && url.pathname.includes("/records")) return json({ code: 0, data: { items: records, has_more: false } });
    if (method === "POST" && url.pathname.includes("/records")) {
      const record = { record_id: `rec${records.length + 1}`, fields: (JSON.parse(body) as { fields: Record<string, unknown> }).fields };
      records.push(record);
      return json({ code: 0, data: { record } });
    }
    if (method === "POST" && url.pathname.endsWith("/medias/upload_all")) return json({ code: 0, data: { file_token: "file-token-1" } });
    if (method === "DELETE") return json({ code: 0, data: {} });
    return json({ code: 1, msg: `unexpected ${method} ${url.pathname}` });
  };
  return { fetch, calls, records, createdApps: () => createdApps, grants: () => grants };
}

function createdBaseCalls(fake: Fake): number {
  return fake.calls.filter((call) => call.method === "POST" && /\/bitable\/v1\/apps$/.test(new URL(call.href).pathname)).length;
}

test("connect scopes stay at full bitable control and are documented", async () => {
  assert.equal(feishuLibraryTenantScopes.length, 27);
  assert.equal(feishuLibraryUserScopes.length, 28);
  for (const scope of ["base:table:delete", "base:field:delete", "base:record:delete", "base:role:delete", "base:view:write_only", "drive:drive", "docs:document.media:upload"]) {
    assert.equal(feishuLibraryTenantScopes.includes(scope as (typeof feishuLibraryTenantScopes)[number]), true, scope);
  }
  assert.equal(feishuLibraryUserScopes.includes("offline_access"), true);
  assert.equal(feishuLibraryUserScopes.includes("space:document:retrieve"), true);
  assert.equal(feishuLibraryUserScopes.includes("base:record:delete"), true);
  assert.equal((feishuLibraryUserScopes as readonly string[]).includes("drive:drive"), false);
  assert.deepEqual(feishuLibraryConnectScopes(), [...feishuLibraryTenantScopes]);
  assert.deepEqual(feishuLibraryConnectScopes(["docs:document:copy", "bitable:app", "NOT A SCOPE"]), [...feishuLibraryTenantScopes, "docs:document:copy"]);
  assert.deepEqual(
    tenantScopesFromOpenPlatform({
      code: 0,
      data: {
        scopes: [
          { scope_name: "bitable:app", grant_status: 1 },
          { scope_name: "base:record:delete", grant_status: 2 },
          { scope_name: "drive:drive", grant_status: 3 },
        ],
      },
    }, {
      code: 0,
      data: { app: { scopes: [{ scope: "wiki:wiki", token_types: ["tenant"] }, { scope: "offline_access", token_types: ["user"] }] } },
    }),
    ["bitable:app", "base:record:delete", "wiki:wiki"],
  );

  const skill = await readFile(path.join(root, "skills", "lumen", "references", "素材库", "SKILL.md"), "utf8");
  for (const scope of [...feishuLibraryTenantScopes, ...feishuLibraryUserScopes]) assert.equal(skill.includes(scope), true, scope);
  assert.match(skill, /full_access/);
  assert.match(skill, /不另建一个 Base|不会自动新建/);
  assert.match(skill, /原始文件/);
  assert.match(skill, /clone-voice/);
  assert.match(skill, /新建应用/);
  assert.match(skill, /绑定已有应用/);
  assert.match(skill, /qr:/);
  assert.equal(/127\.0\.0\.1|xdg-open|本机打开一个页面/.test(skill), false);

  let seen = "";
  await registerFeishuApp({
    appPreset: { name: "lumen 素材库", desc: "assets" },
    addons: { preset: false, scopes: { tenant: feishuLibraryConnectScopes(), user: [...feishuLibraryUserScopes] } },
    onQRCodeReady: (info) => {
      seen = info.url;
    },
    fetch: fakeFeishu().fetch,
    sleep: async () => undefined,
  });
  const page = new URL(seen);
  assert.equal(page.searchParams.get("createOnly"), null);
  assert.equal(page.searchParams.get("source"), "lumen");
  const packed = page.searchParams.get("addons");
  assert.ok(packed);
  const decoded = JSON.parse(gunzipSync(Buffer.from(packed, "base64url")).toString("utf8")) as { scopes: { tenant: string[]; user: string[] } };
  assert.deepEqual(decoded.scopes.tenant, [...feishuLibraryTenantScopes]);
  assert.deepEqual(decoded.scopes.user, [...feishuLibraryUserScopes]);
});

test("parse a base link and reject a mismatched token", () => {
  const parsed = parseFeishuBaseUrl("https://example.feishu.cn/base/bascnLibraryToken?table=tblAsset01");
  assert.equal(parsed.kind, "base");
  assert.equal(parsed.token, appToken);
  assert.equal(parsed.tableId, "tblAsset01");
  assert.throws(() => parseFeishuBaseUrl("https://example.com/base/bascnLibraryToken"), /Feishu or Lark/);
});

test("binding an existing base adds missing columns and does not create a second base", async () => {
  await withDir(async (dir) => {
    const fake = fakeFeishu({ omit: ["备注"] });
    const cap = capture(envFor(dir), { fetch: fake.fetch, sleep: async () => undefined });
    assert.equal(
      await run(["library", "connect", "feishu", "--app-id", "cli_testapp", "--app-secret", secret, "--app-token", appToken], cap.io),
      0,
      cap.err(),
    );
    assert.equal(createdBaseCalls(fake), 0);
    assert.equal(fake.calls.some((call) => call.method === "POST" && call.body.includes("备注")), true);
    assert.equal(cap.out().includes(secret), false);
    assert.equal(cap.out().includes(appToken), false);
    assert.match(cap.out(), /"connected":true/);
    assert.match(cap.out(), /tblAsset01/);

    const state = JSON.parse(await readFile(path.join(dir, ".config", "lumen", "library", "feishu.json"), "utf8")) as { appToken: string; tableId: string };
    assert.equal(state.appToken, appToken);
    assert.equal(state.tableId, "tblAsset01");
    const stored = await readFile(path.join(dir, ".config", "lumen", "credentials", "library.feishu.app.json"), "utf8");
    assert.equal(stored.includes(secret), true);
    assert.equal(JSON.parse(await readFile(path.join(dir, ".config", "lumen", "library", "feishu.json"), "utf8")).client_secret, undefined);

    const switched = capture(envFor(dir), { fetch: fake.fetch, sleep: async () => undefined });
    assert.equal(
      await run(["library", "connect", "feishu", "--app-id", "cli_testapp", "--app-secret", secret, "--base-url", "https://example.feishu.cn/base/bascnOtherToken?table=tblAsset01"], switched.io),
      1,
    );
    assert.match(switched.err(), /not in this base|That table/);

    const other = fakeFeishu({ libraryOnOther: true });
    const again = capture(envFor(dir), { fetch: other.fetch, sleep: async () => undefined });
    assert.equal(
      await run(["library", "connect", "feishu", "--app-id", "cli_testapp", "--app-secret", secret, "--app-token", "bascnOtherToken"], again.io),
      0,
      again.err(),
    );
    const next = JSON.parse(await readFile(path.join(dir, ".config", "lumen", "library", "feishu.json"), "utf8")) as { appToken: string };
    assert.equal(next.appToken, "bascnOtherToken");
    assert.equal(other.createdApps(), 0);
  });
});

test("a column of the wrong type stops the bind", async () => {
  await withDir(async (dir) => {
    const fake = fakeFeishu({ types: { 名称: 2 } });
    const cap = capture(envFor(dir), { fetch: fake.fetch });
    assert.equal(await run(["library", "connect", "feishu", "--app-id", "cli_testapp", "--app-secret", secret, "--app-token", appToken], cap.io), 1);
    assert.match(cap.err(), /will not change an existing column type/);
    assert.equal(cap.err().includes(secret), false);
    await assert.rejects(readFile(path.join(dir, ".config", "lumen", "library", "feishu.json"), "utf8"));
    assert.equal(createdBaseCalls(fake), 0);
  });
});

test("create is explicit and grants manageable access", async () => {
  await withDir(async (dir) => {
    const home = path.join(dir, ".config", "lumen");
    const fake = fakeFeishu();
    const library = new FeishuLibrary({ home, fetch: fake.fetch, sleep: async () => undefined });
    const seen: string[] = [];
    const state = await library.bind({
      clientId: "cli_testapp",
      clientSecret: secret,
      create: true,
      onUserQr: () => undefined,
      authorizeUser: async (request) => {
        seen.push(...request.scopes);
        return { access_token: userToken, refresh_token: refreshToken, expires_in: 7200, open_id: "ou_user" };
      },
    });
    assert.equal(state.appToken, "bascnCreated");
    assert.equal(state.tableId, "tblAsset01");
    assert.equal(fake.createdApps(), 1);
    assert.equal(fake.grants()[0]?.perm, "full_access");
    assert.equal(seen.includes("base:record:delete"), true);
    assert.equal(seen.includes("offline_access"), true);
    assert.equal(state.defaultTableId, undefined);
  });
});

test("omitting the base does not create one", async () => {
  await withDir(async (dir) => {
    const cap = capture(envFor(dir), { fetch: fakeFeishu().fetch });
    assert.equal(await run(["library", "connect", "feishu", "--app-id", "cli_testapp", "--app-secret", secret], cap.io), 2);
    assert.match(cap.err(), /not created automatically/);
    assert.equal(await run(["library", "connect", "feishu", "--app-id", "cli_testapp", "--app-secret", secret, "--app-token", appToken, "--create"], cap.io), 2);
  });
});

test("status, list, find, and add use the selected table", async () => {
  await withDir(async (dir) => {
    const fake = fakeFeishu();
    const bound = capture(envFor(dir), { fetch: fake.fetch, sleep: async () => undefined });
    assert.equal(await run(["library", "connect", "feishu", "--app-id", "cli_testapp", "--app-secret", secret, "--app-token", appToken], bound.io), 0, bound.err());

    const added = capture(envFor(dir), { fetch: fake.fetch, sleep: async () => undefined });
    assert.equal(
      await run(["library", "add", "--name", "阿哲的声音", "--type", "音色", "--provider", "kitta", "--account", "studio", "--external-id", "voice_123"], added.io),
      0,
      added.err(),
    );
    assert.match(added.out(), /voice_123/);
    assert.equal(added.out().includes(secret), false);

    const found = capture(envFor(dir), { fetch: fake.fetch });
    assert.equal(await run(["library", "find", "阿哲的声音", "--type", "音色"], found.io), 0, found.err());
    assert.match(found.out(), /voice_123/);
    const listed = capture(envFor(dir), { fetch: fake.fetch });
    assert.equal(await run(["library", "list"], listed.io), 0, listed.err());
    assert.match(listed.out(), /阿哲的声音/);

    const again = capture(envFor(dir), { fetch: fake.fetch });
    assert.equal(await run(["library", "add", "--name", "阿哲的声音", "--type", "音色", "--provider", "kitta", "--account", "studio", "--external-id", "voice_999"], again.io), 1);
    assert.match(again.err(), /will not overwrite/);

    const project = path.join(dir, "proj");
    assert.equal(await run(["init", project], capture(envFor(dir)).io), 0);
    assert.equal(
      await run(["providers", "set", "seedance-2", "--provider", "haomao", "--base-url", "https://cat.example/api/v3", "--api-key-env", "KEY_A", "--project", project], capture(envFor(dir)).io),
      0,
    );
    const gen = capture({ ...envFor(dir), KEY_A: "secret-a-value-xx" });
    assert.equal(
      await run(["gen", "video", "--model", "seedance-2", "--shape", "text", "--prompt", "a cat walks", "--duration", "5", "--project", project], gen.io),
      0,
      gen.err(),
    );
  });
});

test("library commands without a selection do not block help or status", async () => {
  await withDir(async (dir) => {
    const status = capture(envFor(dir));
    assert.equal(await run(["library", "status"], status.io), 0);
    assert.match(status.out(), /"connected":false/);
    const list = capture(envFor(dir));
    assert.equal(await run(["library", "list"], list.io), 1);
    assert.match(list.err(), /No Feishu asset library is selected/);
    const clone = capture(envFor(dir));
    assert.equal(await run(["library", "clone-voice", "--name", "阿哲"], clone.io), 1);
    assert.match(clone.err(), /lumen fish clone/);
    const help = capture(envFor(dir));
    assert.equal(await run(["library"], help.io), 0);
    assert.match(help.out(), /--existing/);
    assert.match(help.out(), /--reauthorize/);
    assert.match(help.out(), /qr:/);
    assert.match(help.out(), /No browser page/);
    assert.equal(help.out().includes("127.0.0.1"), false);
  });
});

test("the default connect writes a Feishu QR image and does not open a page", async () => {
  await withDir(async (dir) => {
    const fake = fakeFeishu();
    const cap = capture(envFor(dir), { fetch: fake.fetch, sleep: async () => undefined, readLine: async () => "1" });
    assert.equal(await run(["library", "connect", "feishu"], cap.io), 0, cap.err());
    assert.match(cap.out(), /step: app/);
    assert.match(cap.out(), /step: user/);
    assert.match(cap.out(), /人物库/);
    assert.match(cap.out(), /新建应用/);
    assert.match(cap.out(), /绑定已有应用/);
    const confirm = cap.out().match(/confirm: (\S+)/);
    assert.ok(confirm);
    const confirmUrl = new URL(confirm[1] ?? "");
    assert.equal(confirmUrl.searchParams.get("createOnly"), null);
    assert.equal(confirmUrl.searchParams.get("source"), "lumen");
    const addons = confirmUrl.searchParams.get("addons");
    assert.ok(addons);
    const decoded = JSON.parse(gunzipSync(Buffer.from(addons, "base64url")).toString("utf8")) as { scopes: { tenant: string[]; user: string[] } };
    assert.deepEqual(decoded.scopes.tenant, [...feishuLibraryTenantScopes]);
    assert.deepEqual(decoded.scopes.user, [...feishuLibraryUserScopes]);
    const image = cap.out().match(/qr: (\S*feishu-app-qr\.png)/);
    assert.ok(image);
    const png = await readFile(image[1] ?? "");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const userImage = cap.out().match(/qr: (\S*feishu-user-qr\.png)/);
    assert.ok(userImage);
    assert.equal((await readFile(userImage[1] ?? "")).subarray(0, 4).toString("hex"), "89504e47");
    assert.equal(cap.out().includes("127.0.0.1"), false);
    assert.equal(cap.out().includes(secret), false);
    assert.equal(cap.out().includes(userToken), false);
    assert.equal(createdBaseCalls(fake), 0);
    const state = JSON.parse(await readFile(path.join(dir, ".config", "lumen", "library", "feishu.json"), "utf8")) as { tableId?: string; appToken?: string };
    assert.equal(state.tableId, "tblAsset01");
    assert.equal(state.appToken, appToken);
  });
});

test("an existing app can be bound from prompts without printing the secret", async () => {
  await withDir(async (dir) => {
    const fake = fakeFeishu({ omit: ["备注"] });
    const answers = ["cli_testapp", secret, appToken];
    let index = 0;
    const cap = capture(envFor(dir), {
      fetch: fake.fetch,
      sleep: async () => undefined,
      readLine: async () => answers[index++] ?? "",
    });
    assert.equal(await run(["library", "connect", "feishu", "--existing"], cap.io), 0, cap.err());
    assert.match(cap.out(), /App ID:/);
    assert.equal(cap.out().includes(secret), false);
    assert.equal(cap.err().includes(secret), false);
    assert.equal(cap.out().includes("127.0.0.1"), false);
    assert.equal(createdBaseCalls(fake), 0);
    assert.equal(fake.calls.some((call) => call.method === "POST" && call.body.includes("备注")), true);
  });
});

test("a saved app missing a library scope scans again with the full list", async () => {
  await withDir(async (dir) => {
    const home = path.join(dir, ".config", "lumen");
    await mkdir(path.join(home, "credentials"), { recursive: true });
    await mkdir(path.join(home, "library"), { recursive: true });
    await writeFile(path.join(home, "credentials", "library.feishu.app.json"), `${JSON.stringify({ client_id: "cli_testapp", client_secret: secret })}\n`);
    await writeFile(path.join(home, "credentials", "library.feishu.user.json"), `${JSON.stringify({
      client_id: "cli_testapp",
      access_token: userToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + 3_600_000,
    })}\n`);
    await writeFile(path.join(home, "library", "feishu.json"), `${JSON.stringify({
      format: "lumen.feishu-library@1",
      appId: "cli_testapp",
      appToken,
      tableId: "tblAsset01",
      userCanEdit: true,
    })}\n`);
    const seen: string[][] = [];
    const library = new FeishuLibrary({ home, fetch: fakeFeishu({ scopes: ["bitable:app"] }).fetch, sleep: async () => undefined });
    await library.connect(
      async (request) => {
        seen.push([...request.addons.scopes.tenant]);
        return { client_id: "cli_testapp", client_secret: "rotated-secret-value" };
      },
      () => undefined,
      false,
      async () => ({ action: "create" }),
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], [...feishuLibraryTenantScopes, "bitable:app"].filter((scope, index, all) => all.indexOf(scope) === index));
    assert.equal(seen[0]?.includes("base:role:delete"), true);
  });
});

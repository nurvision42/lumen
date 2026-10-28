import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { chunkPlan, uploadBitableMedia, uploadDriveFile } from "../src/feishu/drive.js";
import { denormalizeFields, fieldBodies, fieldBody, normalizeFields, viewConfig } from "../src/feishu/bitable.js";
import { encodeAddons, registrationPageUrl } from "../src/feishu/register.js";
import { USER_SCOPES } from "../src/feishu/scopes.js";
import { appFile, sessionFile, writeApp, writeSession } from "../src/feishu/store.js";
import type { ApiClient } from "../src/feishu/http.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "test-app-secret-xyz";
const APP_ID = "cli_test_app";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bodyText(body: RequestInit["body"] | null | undefined): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return String(body);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(read: () => string, needle: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (read().includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${needle}\n${read()}`);
}

function env(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: home,
    LUMEN_NO_SKILL_AUTOINSTALL: "1",
    ...extra,
  };
}

test("user scopes cover drive, docs, sheets, bitable, wiki, comments, and sharing", async () => {
  for (const scope of [
    "offline_access",
    "drive:drive",
    "drive:drive.search:readonly",
    "search:docs:read",
    "space:document:retrieve",
    "space:document:delete",
    "docx:document",
    "docs:doc",
    "docs:document.content:read",
    "sheets:spreadsheet",
    "bitable:app",
    "wiki:wiki",
    "wiki:node:read",
    "mindnote:node:read",
    "board:whiteboard:node:read",
    "slides:presentation:write_only",
    "docs:document.comment:create",
    "docs:document.comment:delete",
    "docs:permission.member",
    "docs:permission.setting",
  ]) {
    assert.ok(USER_SCOPES.includes(scope), scope);
  }
  const reference = await readFile(path.join(root, "skills", "lumen", "references", "飞书", "SKILL.md"), "utf8");
  const skill = await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8");
  for (const scope of USER_SCOPES) assert.ok(reference.includes(scope), scope);
  assert.match(reference, /http:\/\/127\.0\.0\.1:9753\/callback/);
  assert.match(reference, /不要调用 `lark-cli`/);
  assert.match(reference, /tenant_access_token/);
  assert.match(reference, /手动后备/);
  assert.match(reference, /oauth\/v1\/app\/registration/);
  assert.match(skill, /references\/飞书\/SKILL\.md/);
  assert.match(skill, /lumen feishu setup/);
  assert.equal(skill.trim().split("\n").length <= 80, true);
  assert.match((await readFile(path.join(root, "README.md"), "utf8")), /lumen feishu setup/);
});

test("registration link prefills user scopes and keeps existing-app selection", () => {
  const url = new URL(registrationPageUrl("https://open.feishu.cn/page/cli?user_code=abc", USER_SCOPES, { name: "lumen" }));
  assert.equal(url.searchParams.get("createOnly"), null);
  assert.equal(url.searchParams.get("user_code"), "abc");
  const packed = url.searchParams.get("addons");
  assert.ok(packed);
  const decoded = JSON.parse(gunzipSync(Buffer.from(packed, "base64url")).toString("utf8")) as { scopes: { user: string[]; tenant?: string[] } };
  assert.deepEqual(decoded.scopes.user, [...USER_SCOPES]);
  assert.equal(decoded.scopes.tenant, undefined);
  assert.equal(encodeAddons(["drive:drive"]).length > 0, true);
});

test("link fields round-trip as record ids", () => {
  assert.deepEqual(normalizeFields({ 关联: { link_record_ids: ["rec2"] }, 标题: "a" }), {
    关联: { linkRecordIds: ["rec2"] },
    标题: "a",
  });
  assert.deepEqual(denormalizeFields({ 关联: { linkRecordIds: ["rec2"] }, 标题: "a" }), { 关联: ["rec2"], 标题: "a" });
});

test("chunk plan splits a file on the server block size", () => {
  assert.deepEqual(chunkPlan(10, 4), [
    { seq: 0, start: 0, end: 4 },
    { seq: 1, start: 4, end: 8 },
    { seq: 2, start: 8, end: 10 },
  ]);
});

test("setup --no-wait asks for an app and does not print the secret", async () => {
  await withDir(async (home) => {
    const calls: string[] = [];
    const cap = capture(env(home), {
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        assert.equal(bodyText(init?.body).includes(SECRET), false);
        return jsonResponse({
          device_code: "device-app",
          user_code: "USER",
          verification_uri_complete: "https://open.feishu.cn/page/cli?user_code=USER",
          expire_in: 60,
          interval: 5,
        });
      },
    });
    assert.equal(await run(["feishu", "setup", "--no-wait"], cap.io), 0, cap.err());
    const printed = JSON.parse(cap.out()) as { verificationUrl: string; phase: string; deviceCode: string };
    assert.equal(printed.phase, "app");
    assert.equal(printed.deviceCode, "device-app");
    const page = new URL(printed.verificationUrl);
    const addons = JSON.parse(gunzipSync(Buffer.from(page.searchParams.get("addons") ?? "", "base64url")).toString("utf8")) as { scopes: { user: string[] } };
    assert.ok(addons.scopes.user.includes("drive:drive"));
    assert.ok(addons.scopes.user.includes("bitable:app"));
    assert.equal(calls[0]?.startsWith("POST https://accounts.feishu.cn/oauth/v1/app/registration"), true);
    assert.equal(`${cap.out()}${cap.err()}`.includes(SECRET), false);
  });
});

test("setup resumes, stores the app, then returns the user grant link", async () => {
  await withDir(async (home) => {
    const seen: Array<{ url: string; body: string; authorization: string }> = [];
    const cap = capture(env(home), {
      fetch: async (url, init) => {
        const body = bodyText(init?.body);
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), body, authorization: headers.get("authorization") ?? "" });
        if (String(url).includes("/app/registration")) {
          return jsonResponse({ client_id: APP_ID, client_secret: SECRET, user_info: { open_id: "ou_owner", tenant_brand: "feishu" } });
        }
        return jsonResponse({
          device_code: "device-user",
          user_code: "U2",
          verification_uri_complete: "https://accounts.feishu.cn/oauth/verify?user_code=U2",
          expires_in: 60,
          interval: 5,
        });
      },
    });
    assert.equal(await run(["feishu", "setup", "--device-code", "device-app", "--once"], cap.io), 0, cap.err());
    const printed = JSON.parse(cap.out()) as { phase: string; deviceCode: string; appId: string };
    assert.equal(printed.phase, "user");
    assert.equal(printed.deviceCode, "device-user");
    assert.equal(printed.appId, APP_ID);
    const stored = JSON.parse(await readFile(appFile(cap.io.env), "utf8")) as { appId: string; appSecret: string };
    assert.equal(stored.appSecret, SECRET);
    assert.equal((await stat(appFile(cap.io.env))).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(appFile(cap.io.env)))).mode & 0o777, 0o700);
    const deviceCall = seen.find((call) => call.url.includes("/device_authorization"));
    assert.ok(deviceCall);
    assert.match(decodeURIComponent(deviceCall.body), /drive:drive/);
    assert.match(decodeURIComponent(deviceCall.body), /offline_access/);
    assert.match(decodeURIComponent(deviceCall.body), /docs:doc/);
    assert.match(decodeURIComponent(deviceCall.body), /wiki:wiki/);
    assert.equal(deviceCall.authorization.startsWith("Basic "), true);
    assert.equal(`${cap.out()}${cap.err()}`.includes(SECRET), false);
  });
});

test("login stores a user token and status does not print it", async () => {
  await withDir(async (home) => {
    const cap = capture(env(home, { FEISHU_APP_ID: APP_ID, FEISHU_APP_SECRET: SECRET }), {
      fetch: async (url) => {
        if (String(url).includes("/oauth/v3/token")) {
          return jsonResponse({
            access_token: "u-access",
            refresh_token: "u-refresh",
            expires_in: 7200,
            refresh_token_expires_in: 86400,
            scope: "drive:drive offline_access",
            token_type: "Bearer",
          });
        }
        return jsonResponse({ code: 0, data: { name: "Ada", open_id: "ou_ada" } });
      },
    });
    assert.equal(await run(["feishu", "login", "--device-code", "device-user", "--once"], cap.io), 0, cap.err());
    const logged = JSON.parse(cap.out()) as { name: string; openId: string; missingScopes: string[] };
    assert.equal(logged.name, "Ada");
    assert.equal(logged.openId, "ou_ada");
    assert.ok(logged.missingScopes.includes("bitable:app"));
    assert.equal(cap.out().includes("u-access"), false);
    assert.equal(cap.out().includes("u-refresh"), false);
    assert.equal((await stat(sessionFile(cap.io.env))).mode & 0o777, 0o600);
    const again = capture(cap.io.env);
    assert.equal(await run(["feishu", "status"], again.io), 0);
    assert.equal(again.out().includes("u-access"), false);
    assert.match(again.out(), /Ada/);
  });
});

test("an expired user token is refreshed before search", async () => {
  await withDir(async (home) => {
    const config = env(home);
    await writeApp(config, { appId: APP_ID, appSecret: SECRET, brand: "feishu", source: "manual" });
    const now = Date.parse("2026-10-28T00:00:00Z");
    await writeSession(config, {
      appId: APP_ID,
      accessToken: "u-old",
      refreshToken: "u-refresh",
      expiresAt: now - 5_000,
      refreshExpiresAt: now + 86_400_000,
      scope: USER_SCOPES.join(" "),
      tokenType: "Bearer",
      openId: "ou_ada",
      name: "Ada",
    });
    const authorizations: string[] = [];
    const cap = capture(config, {
      now: () => new Date(now),
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        authorizations.push(headers.get("authorization") ?? "");
        if (String(url).includes("/oauth/v3/token")) {
          const body = bodyText(init?.body);
          assert.match(decodeURIComponent(body), /grant_type=refresh_token/);
          assert.match(decodeURIComponent(body), /refresh_token=u-refresh/);
          return jsonResponse({
            access_token: "u-new",
            refresh_token: "u-refresh-2",
            expires_in: 7200,
            refresh_token_expires_in: 86400,
            scope: USER_SCOPES.join(" "),
            token_type: "Bearer",
          });
        }
        if (String(url).includes("/user_info")) return jsonResponse({ code: 0, data: { name: "Ada", open_id: "ou_ada" } });
        if (String(url).includes("/suite/docs-api/search/object")) {
          const body = JSON.parse(bodyText(init?.body)) as { docs_types: string[]; search_key: string };
          assert.equal(body.search_key, "排期");
          assert.ok(body.docs_types.includes("bitable"));
          return jsonResponse({
            code: 0,
            data: { docs_entities: [{ docs_token: "bascTOKEN", docs_type: "bitable", title: "排期表" }], has_more: false, total: 1 },
          });
        }
        return jsonResponse({ code: 0, data: { metas: [{ doc_token: "bascTOKEN", url: "https://example.feishu.cn/base/bascTOKEN" }] } });
      },
    });
    assert.equal(await run(["feishu", "search", "排期", "--type", "bitable"], cap.io), 0, cap.err());
    const parsed = JSON.parse(cap.out()) as { items: Array<{ name: string; type: string; token: string; url: string }> };
    assert.deepEqual(parsed.items, [{ name: "排期表", type: "bitable", token: "bascTOKEN", url: "https://example.feishu.cn/base/bascTOKEN" }]);
    assert.equal(authorizations[0]?.startsWith("Basic ") || authorizations[0] === "", true);
    assert.ok(authorizations.includes("Bearer u-new"));
    assert.equal(authorizations.includes("Bearer u-old"), false);
  });
});

test("drive list, upload, delete, and guarded removal", async () => {
  await withDir(async (home) => {
    const config = env(home);
    await writeApp(config, { appId: APP_ID, appSecret: SECRET, brand: "feishu", source: "manual" });
    await writeSession(config, {
      appId: APP_ID,
      accessToken: "u-access",
      refreshToken: "u-refresh",
      expiresAt: Date.now() + 60_000_000,
      refreshExpiresAt: Date.now() + 86_400_000,
      scope: "drive:drive",
      tokenType: "Bearer",
    });
    const file = path.join(home, "clip.txt");
    await writeFile(file, "hello");
    const calls: string[] = [];
    const fetchImpl: NonNullable<import("../src/io.js").IO["fetch"]> = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const target = String(url);
      if (target.includes("/root_folder/meta")) return jsonResponse({ code: 0, data: { token: "fldroot" } });
      if (target.includes("/drive/v1/files?") || target.endsWith("/drive/v1/files")) {
        return jsonResponse({ code: 0, data: { files: [{ name: "排期表", type: "bitable", token: "basc1", url: "https://example.feishu.cn/base/basc1" }], has_more: false } });
      }
      if (target.includes("/upload_all")) return jsonResponse({ code: 0, data: { file_token: "file1" } });
      if (init?.method === "DELETE") return jsonResponse({ code: 0, data: {} });
      return jsonResponse({ code: 0, data: {} });
    };
    const listed = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "ls"], listed.io), 0, listed.err());
    assert.match(listed.out(), /排期表/);
    const refused = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "rm", "--token", "file1", "--type", "file"], refused.io), 2);
    assert.equal(calls.some((call) => call.startsWith("DELETE")), false);
    const removed = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "rm", "--token", "file1", "--type", "file", "--yes"], removed.io), 0, removed.err());
    assert.ok(calls.some((call) => call.startsWith("DELETE") && call.includes("type=file")));
    const uploaded = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "upload", "--file", "clip.txt"], uploaded.io), 0, uploaded.err());
    assert.match(uploaded.out(), /file1/);
  });
});

test("multipart upload and bitable attachment use prepare, part, and finish", async () => {
  await withDir(async (home) => {
    const file = path.join(home, "video.mp4");
    await writeFile(file, Buffer.from("0123456789"));
    const paths: string[] = [];
    const client: ApiClient = {
      io: {
        stdout: () => undefined,
        stderr: () => undefined,
        cwd: home,
        env: {},
        fetch: async (url, init) => {
          paths.push(String(url));
          const body = bodyText(init?.body);
          if (String(url).includes("upload_prepare")) return jsonResponse({ code: 0, data: { upload_id: "upl", block_size: 4, block_num: 3 } });
          if (String(url).includes("upload_part")) {
            assert.match(body, /name="seq"/);
            return jsonResponse({ code: 0, data: {} });
          }
          if (String(url).includes("upload_finish")) {
            assert.match(body, /"block_num":3/);
            return jsonResponse({ code: 0, data: { file_token: "filebig" } });
          }
          return jsonResponse({ code: 0, data: {} });
        },
      },
      openBase: "https://open.feishu.cn",
      token: "u-access",
      secrets: [],
    };
    const drive = await uploadDriveFile(client, file, { folderToken: "fld", simpleLimit: 4 });
    assert.equal(drive.token, "filebig");
    assert.equal(paths.filter((item) => item.includes("/files/upload_part")).length, 3);
    const mediaPaths: string[] = [];
    const media: ApiClient = {
      ...client,
      io: {
        ...client.io,
        fetch: async (url, init) => {
          mediaPaths.push(String(url));
          if (String(url).includes("upload_prepare")) {
            const body = JSON.parse(bodyText(init?.body)) as { parent_type: string; extra: string };
            assert.equal(body.parent_type, "bitable_file");
            assert.match(body.extra, /drive_route_token/);
            return jsonResponse({ code: 0, data: { upload_id: "med", block_size: 4, block_num: 3 } });
          }
          if (String(url).includes("upload_part")) return jsonResponse({ code: 0, data: {} });
          return jsonResponse({ code: 0, data: { file_token: "media1" } });
        },
      },
    };
    const attached = await uploadBitableMedia(media, "bascAPP", file, { simpleLimit: 4 });
    assert.equal(attached.fileToken, "media1");
    assert.ok(mediaPaths.some((item) => item.includes("/medias/upload_prepare")));
  });
});

test("bitable filter, link write, doc, sheet, wiki, comment, and share", async () => {
  await withDir(async (home) => {
    const config = env(home);
    await writeApp(config, { appId: APP_ID, appSecret: SECRET, brand: "feishu", source: "manual" });
    await writeSession(config, {
      appId: APP_ID,
      accessToken: "u-access",
      refreshToken: "u-refresh",
      expiresAt: Date.now() + 60_000_000,
      refreshExpiresAt: Date.now() + 86_400_000,
      scope: USER_SCOPES.join(" "),
      tokenType: "Bearer",
    });
    const bodies: Array<{ url: string; body: string; method: string }> = [];
    const fetchImpl: NonNullable<import("../src/io.js").IO["fetch"]> = async (url, init) => {
      const target = String(url);
      const body = bodyText(init?.body);
      bodies.push({ url: target, body, method: init?.method ?? "GET" });
      if (target.includes("/records/search")) {
        return jsonResponse({ code: 0, data: { items: [{ record_id: "rec1", fields: { 关联: { link_record_ids: ["rec2"] } } }], has_more: false } });
      }
      if (target.includes("/records/") && init?.method === "PUT") return jsonResponse({ code: 0, data: { record: { record_id: "rec1", fields: {} } } });
      if (target.includes("/records") && init?.method === "POST" && !target.includes("search")) return jsonResponse({ code: 0, data: { record: { record_id: "rec9", fields: {} } } });
      if (target.includes("/doc/v2/") && target.includes("/raw_content")) return jsonResponse({ code: 0, data: { content: "old" } });
      if (target.includes("/raw_content")) return jsonResponse({ code: 0, data: { content: "hello doc" } });
      if (target.includes("/docx/v1/documents") && init?.method === "POST" && !target.includes("/children")) return jsonResponse({ code: 0, data: { document: { document_id: "dox1", title: "纪要" } } });
      if (target.includes("/blocks") && init?.method === "GET") return jsonResponse({ code: 0, data: { items: [{ block_id: "dox1", block_type: 1, children: ["a"] }], has_more: false } });
      if (target.includes("/children")) return jsonResponse({ code: 0, data: {} });
      if (target.includes("/values/")) return jsonResponse({ code: 0, data: { valueRange: { range: "s1!A1:B1", values: [["a", "b"]] } } });
      if (target.includes("/values") && init?.method === "PUT") return jsonResponse({ code: 0, data: { updatedCells: 2 } });
      if (target.includes("/wiki/v1/nodes/search")) return jsonResponse({ code: 0, data: { items: [{ node_id: "wik1", title: "规范", obj_type: "docx", obj_token: "dox9" }], has_more: false } });
      if (target.includes("/comments") && init?.method === "POST") return jsonResponse({ code: 0, data: { comment_id: "cmt1" } });
      if (target.includes("/public") && init?.method === "PATCH") return jsonResponse({ code: 0, data: { link_share_entity: "tenant_readable" } });
      return jsonResponse({ code: 0, data: {} });
    };
    const records = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "records", "--app", "basc", "--table", "tbl", "--filter", "{\"conjunction\":\"and\",\"conditions\":[]}"], records.io), 0, records.err());
    assert.match(records.out(), /linkRecordIds/);
    const created = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "create", "--app", "basc", "--table", "tbl", "--fields", "{\"关联\":{\"linkRecordIds\":[\"rec2\"]}}"], created.io), 0, created.err());
    const createBody = bodies.find((call) => call.method === "POST" && call.url.includes("/records") && !call.url.includes("search"));
    assert.match(createBody?.body ?? "", /"关联":\["rec2"\]/);
    const doc = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "doc", "get", "--token", "dox1"], doc.io), 0, doc.err());
    assert.match(doc.out(), /hello doc/);
    const classic = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "doc", "get", "--token", "docToken", "--kind", "doc"], classic.io), 0, classic.err());
    assert.match(classic.out(), /"kind":"doc"/);
    const written = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "doc", "write", "--token", "dox1", "--text", "下一行", "--mode", "append"], written.io), 0, written.err());
    const child = bodies.find((call) => call.url.includes("/children") && call.method === "POST");
    assert.match(child?.body ?? "", /下一行/);
    const sheet = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "sheet", "put", "--token", "sht", "--range", "s1!A1:B1", "--values", "[[\"a\",1]]"], sheet.io), 0, sheet.err());
    const wiki = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "wiki", "search", "规范"], wiki.io), 0, wiki.err());
    assert.match(wiki.out(), /wik1/);
    const note = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "comment", "add", "--token", "dox1", "--type", "docx", "--text", "看一下"], note.io), 0, note.err());
    const blocked = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "perm", "share", "--token", "dox1", "--type", "docx", "--link", "anyone_readable"], blocked.io), 2);
    const shared = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "perm", "share", "--token", "dox1", "--type", "docx", "--link", "tenant_readable", "--yes"], shared.io), 0, shared.err());
    assert.ok(bodies.some((call) => call.method === "PATCH" && call.body.includes("tenant_readable")));
  });
});

test("manual app save and callback login", async () => {
  await withDir(async (home) => {
    const config = env(home, { FEISHU_APP_ID: APP_ID, FEISHU_APP_SECRET: SECRET });
    const saved = capture(config);
    assert.equal(await run(["feishu", "app"], saved.io), 0, saved.err());
    assert.equal(saved.out().includes(SECRET), false);
    assert.equal((await stat(appFile(config))).mode & 0o777, 0o600);
    const port = await freePort();
    const cap = capture(config, {
      fetch: async (url, init) => {
        const body = decodeURIComponent(bodyText(init?.body));
        if (String(url).includes("/oauth/v3/token")) {
          assert.match(body, /grant_type=authorization_code/);
          assert.match(body, new RegExp(`redirect_uri=http://127.0.0.1:${port}/callback`));
          return jsonResponse({
            access_token: "u-access",
            refresh_token: "u-refresh",
            expires_in: 7200,
            refresh_token_expires_in: 86400,
            scope: USER_SCOPES.join(" "),
            token_type: "Bearer",
          });
        }
        return jsonResponse({ code: 0, data: { name: "Ada", open_id: "ou_ada" } });
      },
    });
    const pending = run(["feishu", "login", "--callback", "--port", String(port)], cap.io);
    await waitFor(() => cap.err(), "accounts.feishu.cn");
    const link = cap.err().match(/https:\/\/accounts\.feishu\.cn\/\S+/)?.[0];
    assert.ok(link);
    const auth = new URL(link);
    assert.match(auth.searchParams.get("scope") ?? "", /drive:drive/);
    assert.equal(auth.searchParams.get("redirect_uri"), `http://127.0.0.1:${port}/callback`);
    const callback = await fetch(`${auth.searchParams.get("redirect_uri")}?code=auth-code&state=${auth.searchParams.get("state")}`);
    assert.equal(callback.status, 200);
    assert.equal(await pending, 0);
    assert.equal(cap.out().includes(SECRET), false);
    const loggedOut = capture(config);
    assert.equal(await run(["feishu", "logout"], loggedOut.io), 0);
    await assert.rejects(stat(sessionFile(config)));
  });
});

test("missing app credentials name setup and the manual command", async () => {
  await withDir(async (home) => {
    const cap = capture(env(home));
    assert.equal(await run(["feishu", "login"], cap.io), 1);
    assert.match(cap.err(), /lumen feishu setup/);
    assert.match(cap.err(), /lumen feishu app/);
    const help = capture(env(home));
    assert.equal(await run(["--help"], help.io), 0);
    assert.match(help.out(), /lumen feishu setup/);
  });
});

test("field bodies cover text, select, number, attachment, and both link directions", () => {
  assert.deepEqual(fieldBody({ name: "标题", type: "text" }, "--field"), { field_name: "标题", type: 1 });
  assert.deepEqual(fieldBody({ name: "数量", type: "数字", formatter: "0.00" }, "--field"), {
    field_name: "数量",
    type: 2,
    property: { formatter: "0.00" },
  });
  assert.deepEqual(fieldBody({ name: "状态", type: "select", options: ["待办", { name: "完成", color: 1 }] }, "--field"), {
    field_name: "状态",
    type: 3,
    property: { options: [{ name: "待办" }, { name: "完成", color: 1 }] },
  });
  assert.deepEqual(fieldBody({ field_name: "素材", type: 17 }, "--field"), { field_name: "素材", type: 17 });
  assert.deepEqual(fieldBody({ name: "关联", type: "18", linkTable: "tblB" }, "--field"), {
    field_name: "关联",
    type: 18,
    property: { table_id: "tblB" },
  });
  assert.deepEqual(fieldBody({ name: "双向", type: "duplex", table_id: "tblB", backField: "来源", multiple: false }, "--field"), {
    field_name: "双向",
    type: 21,
    property: { table_id: "tblB", multiple: false, back_field_name: "来源" },
  });
  assert.deepEqual(fieldBody({ field_name: "单向关联", type: 18, property: { table_id: "tblB", multiple: true } }, "--field"), {
    field_name: "单向关联",
    type: 18,
    property: { table_id: "tblB", multiple: true },
  });
  assert.throws(() => fieldBody({ name: "双向", type: "双向关联", linkTable: "tblB" }, "--field"), /other side/);
  assert.throws(() => fieldBody({ name: "标题", type: "text", linkTable: "tblB" }, "--field"), /target table/);
  assert.throws(() => fieldBodies({ name: "标题", type: "text" }, "--fields"), /JSON array/);
  assert.deepEqual(viewConfig([{ field: "状态", desc: false }], "sort"), { sort_config: [{ field: "状态", desc: false }] });
  assert.deepEqual(viewConfig({ group_config: [{ field_name: "状态" }] }, "group"), { group_config: [{ field: "状态", desc: false }] });
  assert.deepEqual(viewConfig([], "sort"), { sort_config: [] });
  assert.throws(() => viewConfig(Array.from({ length: 11 }, () => ({ field: "状态" })), "sort"), /at most 10/);
  assert.throws(() => viewConfig([{ field: "a" }, { field: "b" }, { field: "c" }, { field: "d" }], "group"), /at most 3/);
});

test("bitable schema flags are rejected before login", async () => {
  await withDir(async (home) => {
    const duplex = capture(env(home));
    assert.equal(await run(["feishu", "bitable", "create-field", "--app", "basc", "--table", "tbl", "--name", "关联", "--type", "duplex", "--link-table", "tblB"], duplex.io), 2);
    assert.match(duplex.err(), /other side/);
    const mixed = capture(env(home));
    assert.equal(await run(["feishu", "bitable", "create-field", "--app", "basc", "--table", "tbl", "--name", "标题", "--type", "text", "--field", "{\"field_name\":\"标题\",\"type\":1}"], mixed.io), 2);
    assert.match(mixed.err(), /use either/);
    const view = capture(env(home));
    assert.equal(await run(["feishu", "bitable", "create-table", "--app", "basc", "--name", "任务", "--view-name", "表格"], view.io), 2);
    assert.match(view.err(), /--view-name requires --fields/);
    const grouped = capture(env(home));
    assert.equal(await run(["feishu", "bitable", "view-group", "--app", "basc", "--table", "tbl", "--view", "vew", "--group", "[{\"field\":\"a\"},{\"field\":\"b\"},{\"field\":\"c\"},{\"field\":\"d\"}]"], grouped.io), 2);
    assert.match(grouped.err(), /at most 3/);
    assert.equal(`${duplex.out()}${duplex.err()}${mixed.out()}${view.out()}`.includes(SECRET), false);
  });
});

test("bitable schema commands and wiki spaces", async () => {
  await withDir(async (home) => {
    const config = env(home);
    await writeApp(config, { appId: APP_ID, appSecret: SECRET, brand: "feishu", source: "manual" });
    await writeSession(config, {
      appId: APP_ID,
      accessToken: "u-access",
      refreshToken: "u-refresh",
      expiresAt: Date.now() + 60_000_000,
      refreshExpiresAt: Date.now() + 86_400_000,
      scope: USER_SCOPES.join(" "),
      tokenType: "Bearer",
    });
    const fieldFile = path.join(home, "field.json");
    await writeFile(fieldFile, JSON.stringify({ field_name: "素材", type: 17 }));
    let libraryInList = false;
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const fetchImpl: NonNullable<import("../src/io.js").IO["fetch"]> = async (url, init) => {
      const target = String(url);
      const method = init?.method ?? "GET";
      const body = bodyText(init?.body);
      calls.push({ url: target, method, body });
      assert.equal(body.includes(SECRET), false);
      assert.equal(target.includes(SECRET), false);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer u-access");
      if (method === "POST" && target.endsWith("/bitable/v1/apps")) {
        const parsed = JSON.parse(body) as { name?: string; folder_token?: string };
        if (parsed.folder_token !== undefined) {
          return jsonResponse({
            code: 0,
            data: { app: { app_token: "bascNEW", name: parsed.name, folder_token: parsed.folder_token, url: "https://example.feishu.cn/base/bascNEW", default_table_id: "tbl0" } },
          });
        }
        return jsonResponse({ code: 0, data: { app: { app_token: "bascROOT", name: parsed.name, default_table_id: "tblRoot" } } });
      }
      if (method === "POST" && new URL(target).pathname.endsWith("/tables")) {
        return jsonResponse({ code: 0, data: { table_id: "tblNew", default_view_id: "vew0", field_id_list: ["fld1", "fld2"] } });
      }
      if (method === "POST" && target.includes("/fields")) {
        const parsed = JSON.parse(body) as { field_name?: string; type?: number; property?: unknown };
        return jsonResponse({ code: 0, data: { field: { field_id: "fldNew", field_name: parsed.field_name, type: parsed.type, property: parsed.property } } });
      }
      if (method === "PUT" && target.includes("/fields/")) {
        const parsed = JSON.parse(body) as { field_name?: string; type?: number; property?: unknown };
        return jsonResponse({ code: 0, data: { field: { field_id: "fldOld", field_name: parsed.field_name, type: parsed.type, property: parsed.property } } });
      }
      if (method === "POST" && target.includes("/bitable/v1/") && target.endsWith("/views")) {
        return jsonResponse({ code: 0, data: { view: { view_id: "vewKanban", view_name: "看板", view_type: "kanban" } } });
      }
      if (method === "PUT" && target.includes("/base/v3/") && (target.endsWith("/sort") || target.endsWith("/group"))) {
        return jsonResponse({ code: 0, data: JSON.parse(body) as unknown });
      }
      if (target.includes("/wiki/v2/spaces/my_library")) {
        const parsed = new URL(target);
        assert.equal(parsed.searchParams.get("lang"), "zh");
        return jsonResponse({ code: 0, data: { space: { name: "我的文档库", space_id: "sp-lib", space_type: "my_library", description: "", visibility: "private" } } });
      }
      if (target.includes("/wiki/v2/spaces")) {
        const parsed = new URL(target);
        assert.equal(parsed.searchParams.get("space_type"), null);
        assert.equal(parsed.searchParams.get("page_size"), "50");
        const token = parsed.searchParams.get("page_token");
        if (token === null) return jsonResponse({ code: 0, data: { items: [], has_more: true, page_token: "next" } });
        assert.equal(token, "next");
        const items = libraryInList
          ? [{ name: "我的文档库", space_id: "sp-lib", space_type: "my_library" }, { name: "团队", space_id: "sp-team", space_type: "team" }]
          : [{ name: "个人空间", space_id: "sp-person", space_type: "person" }, { name: "团队", space_id: "sp-team", space_type: "team" }];
        return jsonResponse({ code: 0, data: { items, has_more: false } });
      }
      throw new Error(`unexpected ${method} ${target}`);
    };

    const created = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "create-app", "--name", "排期", "--folder", "fld1"], created.io), 0, created.err());
    const appJson = JSON.parse(created.out()) as { appToken: string; url: string; defaultTableId: string; folderToken: string };
    assert.equal(appJson.appToken, "bascNEW");
    assert.equal(appJson.url, "https://example.feishu.cn/base/bascNEW");
    assert.equal(appJson.defaultTableId, "tbl0");
    assert.equal(appJson.folderToken, "fld1");
    assert.equal(created.out().includes("u-access"), false);
    assert.equal(created.out().includes(SECRET), false);

    const rooted = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "create-app", "--name", "根目录"], rooted.io), 0, rooted.err());
    assert.equal(JSON.parse(rooted.out()).url, "https://www.feishu.cn/base/bascROOT");

    const table = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "create-table", "--app", "bascNEW", "--name", "任务", "--view-name", "表格", "--fields", "[{\"name\":\"标题\",\"type\":\"text\"},{\"name\":\"状态\",\"type\":\"select\",\"options\":[\"待办\",\"完成\"]}]"], table.io), 0, table.err());
    assert.deepEqual(JSON.parse(table.out()), { tableId: "tblNew", defaultViewId: "vew0", fieldIdList: ["fld1", "fld2"] });
    const tableCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/tables"));
    assert.deepEqual(JSON.parse(tableCall?.body ?? "{}"), {
      table: {
        name: "任务",
        default_view_name: "表格",
        fields: [
          { field_name: "标题", type: 1 },
          { field_name: "状态", type: 3, property: { options: [{ name: "待办" }, { name: "完成" }] } },
        ],
      },
    });

    const linked = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "create-field", "--app", "bascNEW", "--table", "tblNew", "--name", "关联任务", "--type", "duplex", "--link-table", "tblB", "--back-field", "来源", "--multiple"], linked.io), 0, linked.err());
    const linkCall = calls.find((call) => call.method === "POST" && call.url.includes("/fields"));
    assert.deepEqual(JSON.parse(linkCall?.body ?? "{}"), {
      field_name: "关联任务",
      type: 21,
      property: { table_id: "tblB", multiple: true, back_field_name: "来源" },
    });
    assert.equal(JSON.parse(linked.out()).fieldId, "fldNew");

    const attached = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "create-field", "--app", "bascNEW", "--table", "tblNew", "--field-file", fieldFile], attached.io), 0, attached.err());
    const fileCall = calls.filter((call) => call.method === "POST" && call.url.includes("/fields")).at(-1);
    assert.deepEqual(JSON.parse(fileCall?.body ?? "{}"), { field_name: "素材", type: 17 });

    const updated = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "update-field", "--app", "bascNEW", "--table", "tblNew", "--field-id", "fldOld", "--name", "状态", "--type", "select", "--option", "待办", "--option", "完成"], updated.io), 0, updated.err());
    const updateCall = calls.find((call) => call.method === "PUT" && call.url.includes("/fields/fldOld"));
    assert.deepEqual(JSON.parse(updateCall?.body ?? "{}"), {
      field_name: "状态",
      type: 3,
      property: { options: [{ name: "待办" }, { name: "完成" }] },
    });

    const view = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "create-view", "--app", "bascNEW", "--table", "tblNew", "--name", "看板", "--type", "kanban", "--group", "[{\"field\":\"状态\",\"desc\":false}]"], view.io), 0, view.err());
    const viewJson = JSON.parse(view.out()) as { viewId: string; viewType: string; group: { group_config: unknown } };
    assert.equal(viewJson.viewId, "vewKanban");
    assert.equal(viewJson.viewType, "kanban");
    assert.deepEqual(viewJson.group.group_config, [{ field: "状态", desc: false }]);
    assert.ok(calls.some((call) => call.method === "PUT" && call.url.endsWith("/views/vewKanban/group")));

    const sorted = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "bitable", "view-sort", "--app", "bascNEW", "--table", "tblNew", "--view", "vewGrid", "--sort", "[{\"field\":\"截止时间\",\"desc\":true}]"], sorted.io), 0, sorted.err());
    const sortCall = calls.find((call) => call.method === "PUT" && call.url.endsWith("/views/vewGrid/sort"));
    assert.deepEqual(JSON.parse(sortCall?.body ?? "{}"), { sort_config: [{ field: "截止时间", desc: true }] });

    calls.length = 0;
    const spaces = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "wiki", "spaces"], spaces.io), 0, spaces.err());
    const listed = JSON.parse(spaces.out()) as { items: Array<{ space_id: string; space_type: string }>; hasMore: boolean };
    assert.equal(listed.hasMore, false);
    assert.deepEqual(listed.items.map((item) => item.space_id), ["sp-lib", "sp-person", "sp-team"]);
    const spaceGets = calls.filter((call) => call.method === "GET" && call.url.includes("/wiki/v2/spaces") && !call.url.includes("my_library"));
    assert.equal(spaceGets.length, 2);
    assert.equal(new URL(spaceGets[0]?.url ?? "").searchParams.get("page_token"), null);
    assert.equal(new URL(spaceGets[1]?.url ?? "").searchParams.get("page_token"), "next");
    assert.equal(spaces.out().includes("u-access"), false);
    assert.equal(spaces.out().includes(SECRET), false);

    libraryInList = true;
    const again = capture(config, { fetch: fetchImpl, cwd: home });
    assert.equal(await run(["feishu", "wiki", "spaces"], again.io), 0, again.err());
    const deduped = JSON.parse(again.out()) as { items: Array<{ space_id: string }> };
    assert.deepEqual(deduped.items.map((item) => item.space_id), ["sp-lib", "sp-team"]);
  });
});

test("prompted app id is stored without echoing the secret", async () => {
  await withDir(async (home) => {
    const answers = ["cli_prompted", SECRET];
    const cap = capture(env(home), { readLine: async () => answers.shift() ?? "" });
    assert.equal(await run(["feishu", "app"], cap.io), 0, cap.err());
    const stored = JSON.parse(await readFile(appFile(cap.io.env), "utf8")) as { appId: string; appSecret: string };
    assert.equal(stored.appId, "cli_prompted");
    assert.equal(stored.appSecret, SECRET);
    assert.equal(cap.out().includes(SECRET), false);
    assert.equal(cap.err().includes(SECRET), false);
  });
});

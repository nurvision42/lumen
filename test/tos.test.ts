import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { presignTosGet, TOS_PRESIGN_SECONDS, tosDoctorLine, tosObjectKey, tosPutAuthHeaders } from "../src/clients/tos.js";
import { loadConfig, parseConfig, resolveTos, TOS_DEFAULTS, writeConfigFile } from "../src/config.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const GO_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GO_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const GO_NOW = new Date("2021-07-21T10:44:54.000Z");

test("presigned GET matches ve-tos-golang-sdk TestAlgV4", () => {
  const url = presignTosGet({
    accessKeyId: GO_ACCESS_KEY,
    secretAccessKey: GO_SECRET_KEY,
    region: "cn-north-1",
    bucket: "test",
    endpoint: "tos.com:8080",
    key: "test.txt",
    now: GO_NOW,
    expiresSeconds: 3600,
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://test.tos.com:8080/test.txt");
  assert.equal(parsed.searchParams.get("X-Tos-Algorithm"), "TOS4-HMAC-SHA256");
  assert.equal(parsed.searchParams.get("X-Tos-Date"), "20210721T104454Z");
  assert.equal(parsed.searchParams.get("X-Tos-SignedHeaders"), "host");
  assert.equal(parsed.searchParams.get("X-Tos-Credential"), `${GO_ACCESS_KEY}/20210721/cn-north-1/tos/request`);
  assert.equal(parsed.searchParams.get("X-Tos-Expires"), "3600");
  assert.equal(parsed.searchParams.get("X-Tos-Signature"), "decc75e2b2d453117f81e53954eb2cd3a2f56db2951e9b2257863db4c4921111");
  assert.equal(parsed.searchParams.get("X-Tos-Content-Sha256"), null);
  assert.equal(url.includes(GO_SECRET_KEY), false);
});

test("header signature matches ve-tos-golang-sdk TestAlgV4", () => {
  const headers = tosPutAuthHeaders({
    accessKeyId: GO_ACCESS_KEY,
    secretAccessKey: GO_SECRET_KEY,
    region: "cn-north-1",
    bucket: "test",
    endpoint: "tos.com:8080",
    key: "test.txt",
    now: GO_NOW,
    method: "GET",
  });
  assert.equal(headers["x-tos-date"], "20210721T104454Z");
  assert.equal(headers["x-tos-content-sha256"], undefined);
  assert.equal(
    headers.Authorization,
    "TOS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20210721/cn-north-1/tos/request,SignedHeaders=host;x-tos-date,Signature=3453b54ecfc50e6ed3fc15cbdb82f8a18d644063302080fb18ee10daa4f1a23f",
  );
  assert.equal((headers.Authorization ?? "").includes(GO_SECRET_KEY), false);
});

test("object keys are content-addressed and keep a safe extension", () => {
  assert.equal(tosObjectKey("/tmp/a.PNG", "abc"), "lumen-abc.png");
  assert.equal(tosObjectKey("/tmp/noext", "abc"), "lumen-abc");
  assert.equal(TOS_PRESIGN_SECONDS, 3 * 24 * 60 * 60);
});

test("empty tos block resolves lumen42 defaults; a scheme on the endpoint is stripped", () => {
  assert.deepEqual(resolveTos({}), TOS_DEFAULTS);
  assert.equal(resolveTos({ endpoint: "https://tos-cn-beijing.volces.com/" }).endpoint, "tos-cn-beijing.volces.com");
  assert.equal(resolveTos({ bucket: "other" }).bucket, "other");
  assert.equal(resolveTos({ accessKeyEnv: "MY_AK" }).accessKeyEnv, "MY_AK");
  assert.throws(() => parseConfig({ tos: { nope: true } }, "cfg"), /tos/);
});

test("project tos overrides one global field and providers set keeps the block", async () => {
  await withDir(async (dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, ".xdg"), HOME: path.join(dir, "home") };
    const globalFile = path.join(env.XDG_CONFIG_HOME, "lumen", "providers.json");
    await mkdir(path.dirname(globalFile), { recursive: true });
    await writeConfigFile(globalFile, {
      models: {},
      breakdown: {},
      tools: {},
      tos: { bucket: "from-global", region: "cn-beijing" },
    });
    await writeFile(path.join(dir, "lumen.config.json"), `${JSON.stringify({ tos: { bucket: "from-project" } }, null, 2)}\n`);
    const loaded = await loadConfig(dir, env);
    assert.equal(loaded.config.tos?.bucket, "from-project");
    assert.equal(loaded.config.tos?.region, "cn-beijing");
    assert.equal(loaded.config.tos?.endpoint, TOS_DEFAULTS.endpoint);
    assert.equal(loaded.config.tos?.accessKeyEnv, "VOLC_ACCESSKEY");

    const set = capture(env);
    assert.equal(
      await run(
        ["providers", "set", "seedance-2.5", "--provider", "ycyapi", "--api-key-env", "YK", "--project", dir],
        set.io,
      ),
      0,
      set.err(),
    );
    const stored = JSON.parse(await readFile(path.join(dir, "lumen.config.json"), "utf8")) as { tos?: { bucket?: string } };
    assert.equal(stored.tos?.bucket, "from-project");

    const doctor = capture({ ...env, VOLCENGINE_SECRET_KEY: "secret-value-not-printed" });
    assert.equal(await run(["doctor", "--project", dir], doctor.io), 0, doctor.err());
    assert.match(doctor.out(), /tos: from-project cn-beijing tos-cn-beijing\.volces\.com access missing \(VOLC_ACCESSKEY or VOLCENGINE_ACCESS_KEY\) secret present \(VOLCENGINE_SECRET_KEY\)/);
    assert.equal(doctor.out().includes("secret-value-not-printed"), false);
  });
});

test("doctor says tos is not configured when the block is absent", async () => {
  await withDir(async (dir) => {
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, ".xdg") };
    assert.equal(tosDoctorLine(undefined, env), "tos: not configured");
    const cap = capture(env);
    assert.equal(await run(["doctor", "--project", dir], cap.io), 0, cap.err());
    assert.match(cap.out(), /tos: not configured/);
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, writeConfigFile } from "../src/config.js";
import { run } from "../src/run.js";
import { platformId } from "../src/tools/catalog.js";
import { lumenCacheDir } from "../src/tools/cache.js";
import { configuredBinary, resolveBinary, resolveSharp } from "../src/tools/resolve.js";
import { capture, withDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));

async function fakeBin(dir: string, name: string, version: string, fail = false): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const body = fail
    ? "#!/bin/sh\nexit 1\n"
    : `#!/bin/sh\nif [ "$1" = "-version" ]; then\n  echo "${name} version ${version}"\n  exit 0\nfi\nexit 1\n`;
  await writeFile(file, body, { mode: 0o755 });
  return file;
}

function isolated(dir: string, pathValue = ""): NodeJS.ProcessEnv {
  return {
    PATH: pathValue,
    HOME: dir,
    XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
  };
}

test("package install does not depend on sharp or ffmpeg packages", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    files?: string[];
  };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ["zod"]);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.files?.includes("skills"), true);
  const lock = await readFile(path.join(root, "package-lock.json"), "utf8");
  assert.equal(lock.includes("ffmpeg-static"), false);
  assert.equal(lock.includes("ffprobe-static"), false);
  assert.equal(lock.includes("node_modules/sharp"), false);
});

test("ffmpeg resolution is config, then PATH, then cache, then a hashed download", async () => {
  await withDir(async (dir) => {
    const configured = await fakeBin(path.join(dir, "configured"), "ffmpeg", "1.0.0-config");
    const broken = await fakeBin(path.join(dir, "broken"), "ffmpeg", "0", true);
    const onPath = await fakeBin(path.join(dir, "path-bin"), "ffmpeg", "2.0.0-path");
    const later = await fakeBin(path.join(dir, "later-bin"), "ffmpeg", "3.0.0-path");
    const env = isolated(dir, `${path.dirname(broken)}:${path.dirname(onPath)}:${path.dirname(later)}`);

    const fromConfig = await resolveBinary({
      name: "ffmpeg",
      env: { ...env, LUMEN_FFMPEG: configured },
      configured,
      download: false,
      fetch: async () => {
        throw new Error("config must not download");
      },
    });
    assert.equal(fromConfig?.source, "config");
    assert.equal(fromConfig?.path, configured);
    assert.equal(fromConfig?.version, "1.0.0-config");

    await assert.rejects(
      () => resolveBinary({ name: "ffmpeg", env, configured: broken, download: true }),
      /did not run -version/,
    );

    const fromPath = await resolveBinary({ name: "ffmpeg", env, download: false });
    assert.equal(fromPath?.source, "path");
    assert.equal(fromPath?.path, onPath);
    assert.equal(fromPath?.version, "2.0.0-path");

    const cacheEnv = isolated(dir);
    const cached = path.join(lumenCacheDir(cacheEnv) ?? "", "bin", platformId(), "ffmpeg");
    await fakeBin(path.dirname(cached), "ffmpeg", "4.0.0-cache");
    const fromCache = await resolveBinary({
      name: "ffmpeg",
      env: cacheEnv,
      download: false,
      fetch: async () => {
        throw new Error("cache must not download");
      },
    });
    assert.equal(fromCache?.source, "cache");
    assert.equal(fromCache?.version, "4.0.0-cache");

    const empty = isolated(path.join(dir, "empty"));
    assert.equal(await resolveBinary({
      name: "ffmpeg",
      env: empty,
      download: false,
      fetch: async () => {
        throw new Error("doctor must not download");
      },
    }), undefined);

    const script = Buffer.from("#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then echo \"ffmpeg version 5.0.0-download\"; exit 0; fi\nexit 1\n");
    const sha256 = createHash("sha256").update(script).digest("hex");
    const downloaded = await resolveBinary({
      name: "ffmpeg",
      env: empty,
      download: true,
      asset: { url: "https://example.invalid/ffmpeg.gz", sha256, filename: "ffmpeg" },
      fetch: async () => new Response(gzipSync(script)),
    });
    assert.equal(downloaded?.source, "download");
    assert.equal(downloaded?.version, "5.0.0-download");
    await access(downloaded?.path ?? "", constants.X_OK);
    const again = await resolveBinary({ name: "ffmpeg", env: empty, download: false });
    assert.equal(again?.source, "cache");

    const mismatch = isolated(path.join(dir, "mismatch"));
    await assert.rejects(
      () => resolveBinary({
        name: "ffmpeg",
        env: mismatch,
        download: true,
        asset: { url: "https://example.invalid/ffmpeg.gz", sha256: "a".repeat(64), filename: "ffmpeg" },
        fetch: async () => new Response(gzipSync(script)),
      }),
      /hash mismatch/,
    );
    const missed = path.join(lumenCacheDir(mismatch) ?? "", "bin", platformId(), "ffmpeg");
    await assert.rejects(access(missed));
  });
});

test("explicit tool paths override PATH and a project file replaces one global tool", async () => {
  await withDir(async (dir) => {
    const fromEnv = await fakeBin(path.join(dir, "env"), "ffmpeg", "8.0.0-env");
    const fromFile = await fakeBin(path.join(dir, "file"), "ffprobe", "8.1.0-file");
    const globalBin = await fakeBin(path.join(dir, "global"), "ffmpeg", "8.2.0-global");
    const env = isolated(dir, path.dirname(fromFile));
    env.LUMEN_FFMPEG = fromEnv;
    const globalFile = path.join(env.XDG_CONFIG_HOME ?? "", "lumen", "providers.json");
    await writeConfigFile(globalFile, {
      models: {},
      breakdown: {},
      tools: { ffmpeg: globalBin, ffprobe: fromFile },
    });
    await writeFile(path.join(dir, "lumen.config.json"), `${JSON.stringify({ tools: { ffmpeg: "/not/used" } })}\n`);
    const loaded = await loadConfig(dir, env);
    assert.equal(configuredBinary("ffmpeg", env, loaded.config.tools), fromEnv);
    assert.equal(loaded.config.tools.ffprobe, fromFile);
    assert.equal(loaded.config.tools.ffmpeg, "/not/used");
  });
});

test("providers set keeps tool paths and does not invent an empty tools object", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "lumen.config.json"), `${JSON.stringify({ tools: { ffmpeg: "/opt/ffmpeg" } }, null, 2)}\n`);
    const set = capture(isolated(dir));
    assert.equal(
      await run(
        ["providers", "set", "gpt-image-2", "--provider", "yunqiao", "--base-url", "https://yunqiao.example/v1", "--api-key-env", "YUNQIAO_API_KEY", "--project", dir],
        set.io,
      ),
      0,
      set.err(),
    );
    const written = JSON.parse(await readFile(path.join(dir, "lumen.config.json"), "utf8")) as { tools?: { ffmpeg?: string; ffprobe?: string } };
    assert.equal(written.tools?.ffmpeg, "/opt/ffmpeg");
    assert.equal(written.tools?.ffprobe, undefined);

    await writeFile(path.join(dir, "plain.json"), "{}\n");
    await writeConfigFile(path.join(dir, "plain.json"), { models: {}, breakdown: {}, tools: {} });
    const plain = await readFile(path.join(dir, "plain.json"), "utf8");
    assert.equal(plain.includes("tools"), false);
  });
});

test("sharp loads a local module or the cache and refuses a bad integrity", async () => {
  await withDir(async (dir) => {
    const project = path.join(dir, "project");
    await mkdir(path.join(project, "node_modules", "sharp"), { recursive: true });
    await writeFile(path.join(project, "package.json"), "{\"name\":\"fixture\",\"private\":true}\n");
    await writeFile(path.join(project, "node_modules", "sharp", "package.json"), "{\"name\":\"sharp\",\"version\":\"9.9.9-local\"}\n");
    await writeFile(path.join(project, "node_modules", "sharp", "index.js"), "module.exports = function sharp() { return {}; };\n");
    const env = isolated(dir);
    const local = await resolveSharp({ env, project, cwd: project, download: false });
    assert.equal(local?.source, "module");
    assert.equal(local?.version, "9.9.9-local");

    const bare = path.join(dir, "bare");
    await mkdir(bare, { recursive: true });
    await writeFile(path.join(bare, "package.json"), "{\"name\":\"bare\",\"private\":true}\n");
    const cacheRoot = path.join(lumenCacheDir(env) ?? "", "sharp");
    await mkdir(path.join(cacheRoot, "node_modules", "sharp"), { recursive: true });
    await writeFile(path.join(cacheRoot, "package.json"), "{\"name\":\"lumen-sharp-cache\",\"private\":true}\n");
    await writeFile(path.join(cacheRoot, "node_modules", "sharp", "package.json"), "{\"name\":\"sharp\",\"version\":\"9.9.9-cache\"}\n");
    await writeFile(path.join(cacheRoot, "node_modules", "sharp", "index.js"), "module.exports = function sharp() { return {}; };\n");
    const cached = await resolveSharp({
      env,
      project: bare,
      cwd: bare,
      download: false,
      fetch: async () => {
        throw new Error("cache must not download");
      },
    });
    assert.equal(cached?.source, "cache");
    assert.equal(cached?.version, "9.9.9-cache");

    const other = isolated(path.join(dir, "other"));
    const fresh = path.join(dir, "fresh");
    await mkdir(fresh, { recursive: true });
    await writeFile(path.join(fresh, "package.json"), "{\"name\":\"fresh\",\"private\":true}\n");
    assert.equal(await resolveSharp({ env: other, project: fresh, cwd: fresh, download: false }), undefined);
    await assert.rejects(
      () => resolveSharp({
        env: other,
        project: fresh,
        cwd: fresh,
        download: true,
        fetch: async () => new Response(JSON.stringify({ dist: { integrity: "sha512-mismatch" } }), { status: 200 }),
      }),
      /integrity does not match/,
    );
  });
});

test("doctor and setup ffmpeg report the source and do not download when PATH works", async () => {
  await withDir(async (dir) => {
    const bin = path.join(dir, "bin");
    const ffmpeg = await fakeBin(bin, "ffmpeg", "7.0.0-path");
    await fakeBin(bin, "ffprobe", "7.0.0-path");
    const env = isolated(dir, bin);
    const doctor = capture(env, { cwd: dir });
    assert.equal(await run(["doctor", "--project", dir], doctor.io), 0, doctor.err());
    assert.match(doctor.out(), new RegExp(`ffmpeg: ${ffmpeg} 7\\.0\\.0-path source=path`));
    assert.match(doctor.out(), /ffprobe: .+ 7\.0\.0-path source=path/);
    assert.match(doctor.out(), /^sharp: missing$/m);
    assert.match(doctor.out(), /presence only, no network/);
    assert.equal(doctor.err().includes("downloading"), false);

    const setup = capture(env, { cwd: dir });
    assert.equal(await run(["setup", "ffmpeg", "--project", dir], setup.io), 0, setup.err());
    assert.match(setup.out(), /source=path/);
    assert.equal(setup.err().includes("downloading"), false);
    assert.equal(await run(["setup", "ffmpeg", "extra", "--project", dir], capture(env).io), 2);
    const keyed = capture(env);
    assert.equal(await run(["setup", "ffmpeg", "--key", "tikhub", "--project", dir], keyed.io), 2);
    assert.match(keyed.err(), /does not take a key/);
  });
});

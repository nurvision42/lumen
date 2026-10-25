import { readFileSync } from "node:fs";
const PKG_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.js";
import {
  commandStatus,
  configDir,
  dirOnPath,
  installReport,
  packageRootFrom,
  userBinDir,
  userInstallDir,
} from "../src/install/locate.js";
import { capture, withDir } from "./helpers.js";

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = path.join(root, "scripts", "install.sh");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/bash",
    npm_config_cache: process.env.npm_config_cache ?? path.join(homedir(), ".npm"),
    LUMEN_NO_SKILL_AUTOINSTALL: "1",
    ...extra,
  };
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  delete env.npm_config_global;
  delete env.NPM_CONFIG_GLOBAL;
  if (extra.XDG_DATA_HOME === undefined) delete env.XDG_DATA_HOME;
  if (extra.XDG_CONFIG_HOME === undefined) delete env.XDG_CONFIG_HOME;
  if (extra.XDG_CACHE_HOME === undefined) delete env.XDG_CACHE_HOME;
  if (extra.LUMEN_SKILL_DIR === undefined) delete env.LUMEN_SKILL_DIR;
  if (extra.LUMEN_WORKFLOWS_DIR === undefined) delete env.LUMEN_WORKFLOWS_DIR;
  return env;
}

async function runScript(home: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return exec("bash", [script, ...args], {
    cwd: root,
    env: installEnv(home, extra),
    timeout: 180_000,
  });
}

test("install paths stay under the user directory", () => {
  const home = "/home/lumen";
  assert.equal(userBinDir({ HOME: home }), "/home/lumen/.local/bin");
  assert.equal(userInstallDir({ HOME: home }), "/home/lumen/.local/share/lumen");
  assert.equal(userInstallDir({ HOME: home, XDG_DATA_HOME: "/home/lumen/data" }), "/home/lumen/data/lumen");
  assert.equal(userInstallDir({ HOME: home, XDG_DATA_HOME: "/var/lib/lumen" }), "/home/lumen/.local/share/lumen");
  assert.equal(configDir({ HOME: home }), path.join(home, ".config", "lumen"));
  assert.equal(configDir({ HOME: home, XDG_CONFIG_HOME: "/home/lumen/cfg" }), "/home/lumen/cfg/lumen");
  assert.equal(userBinDir({}), undefined);
  assert.equal(dirOnPath("/home/lumen/.local/bin", { PATH: "/usr/bin:/home/lumen/.local/bin" }), true);
  assert.equal(dirOnPath("/home/lumen/.local/bin", { PATH: "/usr/bin" }), false);
  assert.equal(packageRootFrom(path.join(root, "src", "run.ts")), root);
  assert.equal(packageRootFrom(path.join(root, "src", "install", "locate.ts")), root);
});

test("PATH check tells this install from another lumen", async () => {
  await withDir(async (dir) => {
    const install = path.join(dir, "share", "lumen");
    const bin = path.join(dir, "bin");
    await mkdir(path.join(install, "dist"), { recursive: true });
    await mkdir(bin, { recursive: true });
    const cli = path.join(install, "dist", "cli.js");
    await writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(cli, 0o755);
    await symlink(cli, path.join(bin, "lumen"));
    const hit = await commandStatus({ PATH: bin }, install);
    assert.equal(hit.relation, "this");
    assert.equal(hit.path, path.join(bin, "lumen"));

    const otherBin = path.join(dir, "other");
    await mkdir(otherBin, { recursive: true });
    const other = path.join(otherBin, "lumen");
    await writeFile(other, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(other, 0o755);
    const missed = await commandStatus({ PATH: otherBin }, install);
    assert.equal(missed.relation, "other");
    assert.equal(missed.path, other);

    const lines = await installReport({ HOME: dir, PATH: "" }, install);
    assert.equal(lines[0], `lumen: ${install}`);
    assert.equal(lines[1], "lumen on PATH: missing");
    assert.match(lines[2] ?? "", /not on PATH$/);
  });
});

test("doctor reports install location, PATH, config, and cache", async () => {
  await withDir(async (dir) => {
    const bin = path.join(dir, "bin");
    await mkdir(bin, { recursive: true });
    const command = path.join(bin, "lumen");
    await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(command, 0o755);
    const cap = capture({
      HOME: dir,
      PATH: bin,
      XDG_CONFIG_HOME: path.join(dir, "cfg"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
    });
    assert.equal(await run(["doctor", "--project", dir], cap.io), 0, cap.err());
    const text = cap.out();
    assert.match(text, new RegExp(`^lumen: ${escapeRegExp(root)}$`, "m"));
    assert.match(text, new RegExp(`^lumen on PATH: ${escapeRegExp(command)} \\(other\\)$`, "m"));
    assert.match(text, new RegExp(`^user bin: ${escapeRegExp(path.join(dir, ".local", "bin"))} not on PATH$`, "m"));
    assert.match(text, new RegExp(`^config dir: ${escapeRegExp(path.join(dir, "cfg", "lumen"))}$`, "m"));
    assert.match(text, new RegExp(`^cache dir: ${escapeRegExp(path.join(dir, "cache", "lumen"))}$`, "m"));
    assert.match(text, /presence only, no network/);
  });
});

test("install script refuses a prefix outside HOME", async () => {
  await withDir(async (home) => {
    const outside = path.join(tmpdir(), `lumen-outside-${path.basename(home)}`);
    await assert.rejects(() => runScript(home, ["--prefix", outside, "--no-path"]), /refuses to write outside HOME/);
    await assert.rejects(access(outside));
  });
});

test("user install upgrades in place and uninstall leaves config and cache", { timeout: 180_000 }, async () => {
  await withDir(async (home) => {
    const share = path.join(home, ".local", "share", "lumen");
    const bin = path.join(home, ".local", "bin", "lumen");
    const first = await runScript(home, [], { XDG_DATA_HOME: "/var/tmp", SHELL: "/bin/zsh" });
    assert.match(first.stdout, /XDG_DATA_HOME is outside HOME/);
    assert.match(first.stdout, new RegExp(`installed ${escapeRegExp(share)}`));
    assert.match(first.stdout, /PATH does not include/);
    assert.match(first.stdout, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
    assert.match(first.stdout, /re-run with --path/);
    await assert.rejects(access(path.join(home, ".zshrc")));
    await assert.rejects(access(path.join(home, ".bashrc")));
    await access(path.join(share, "skills", "lumen", "SKILL.md"), constants.R_OK);
    await access(path.join(share, "node_modules", "zod", "package.json"), constants.R_OK);
    await assert.rejects(access(path.join(share, "node_modules", "typescript", "package.json")));
    const versionEnv = installEnv(home, { PATH: `${path.dirname(bin)}${path.delimiter}${process.env.PATH ?? ""}` });
    const version = await exec(bin, ["--version"], { env: versionEnv });
    assert.equal(version.stdout.trim(), PKG_VERSION);
    const doctor = await exec(bin, ["doctor", "--project", home], { env: versionEnv });
    assert.match(doctor.stdout, new RegExp(`^lumen: ${escapeRegExp(share)}$`, "m"));
    assert.match(doctor.stdout, new RegExp(`^lumen on PATH: ${escapeRegExp(bin)} \\(this\\)$`, "m"));
    assert.match(doctor.stdout, new RegExp(`^user bin: ${escapeRegExp(path.dirname(bin))} on PATH$`, "m"));
    assert.match(doctor.stdout, new RegExp(`^config dir: ${escapeRegExp(path.join(home, ".config", "lumen"))}$`, "m"));
    assert.match(doctor.stdout, new RegExp(`^cache dir: ${escapeRegExp(path.join(home, ".cache", "lumen"))}$`, "m"));

    const marker = path.join(share, "marker.txt");
    await writeFile(marker, "old\n");
    await runScript(home, ["--no-path"]);
    await assert.rejects(access(marker));
    const upgraded = await exec(bin, ["--version"], { env: versionEnv });
    assert.equal(upgraded.stdout.trim(), PKG_VERSION);

    const linked = await runScript(home, ["--path"], { SHELL: "/bin/zsh" });
    assert.match(linked.stdout, /added .+ to .+\/\.zshrc/);
    const rc = await readFile(path.join(home, ".zshrc"), "utf8");
    const line = 'export PATH="$HOME/.local/bin:$PATH"';
    assert.equal(rc.split(line).length - 1, 1);
    const again = await runScript(home, ["--path"], { SHELL: "/bin/zsh" });
    assert.match(again.stdout, /PATH entry already in/);
    const twice = await readFile(path.join(home, ".zshrc"), "utf8");
    assert.equal(twice.split(line).length - 1, 1);

    const config = path.join(home, ".config", "lumen", "providers.json");
    const cached = path.join(home, ".cache", "lumen", "keep.txt");
    await mkdir(path.dirname(config), { recursive: true });
    await mkdir(path.dirname(cached), { recursive: true });
    await writeFile(config, "{}\n");
    await writeFile(cached, "keep\n");
    const removed = await runScript(home, ["--uninstall"]);
    assert.match(removed.stdout, new RegExp(`removed ${escapeRegExp(bin)}`));
    assert.match(removed.stdout, new RegExp(`uninstalled ${escapeRegExp(share)}`));
    assert.match(removed.stdout, /left config and cache in place/);
    await assert.rejects(access(share));
    await assert.rejects(access(bin));
    assert.equal(await readFile(config, "utf8"), "{}\n");
    assert.equal(await readFile(cached, "utf8"), "keep\n");
    assert.equal((await readFile(path.join(home, ".zshrc"), "utf8")).includes(line), true);
  });
});

test("npm --prefix install puts the command in the user directory", { timeout: 180_000 }, async () => {
  await withDir(async (home) => {
    const prefix = path.join(home, ".local");
    const env = installEnv(home);
    await exec("npm", ["install", "-g", "--prefix", prefix, "--install-links", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", root], {
      cwd: root,
      env,
      timeout: 180_000,
    });
    const bin = path.join(prefix, "bin", "lumen");
    const runEnv = installEnv(home, { PATH: `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH ?? ""}` });
    const version = await exec(bin, ["--version"], { env: runEnv });
    assert.equal(version.stdout.trim(), PKG_VERSION);
    const doctor = await exec(bin, ["doctor", "--project", home], { env: runEnv });
    const installed = path.join(prefix, "lib", "node_modules", "@nurvision", "lumen");
    assert.match(doctor.stdout, new RegExp(`^lumen: ${escapeRegExp(installed)}$`, "m"));
    assert.match(doctor.stdout, new RegExp(`^lumen on PATH: ${escapeRegExp(bin)} \\(this\\)$`, "m"));
    assert.match(doctor.stdout, new RegExp(`^user bin: ${escapeRegExp(path.join(home, ".local", "bin"))} on PATH$`, "m"));
    assert.match(doctor.stdout, new RegExp(`^config dir: ${escapeRegExp(path.join(home, ".config", "lumen"))}$`, "m"));
    assert.match(doctor.stdout, new RegExp(`^cache dir: ${escapeRegExp(path.join(home, ".cache", "lumen"))}$`, "m"));
    assert.equal((await lstat(installed)).isSymbolicLink(), false);
    await access(path.join(installed, "skills", "lumen", "SKILL.md"), constants.R_OK);
    await access(path.join(installed, "node_modules", "zod", "package.json"), constants.R_OK);
    await assert.rejects(access(path.join(installed, "node_modules", "typescript", "package.json")));
    await assert.rejects(access("/usr/local/bin/lumen"));
  });
});

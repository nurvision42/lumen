import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SHOT_FIELDS, parseShotlistData, shotSchema } from "../src/shotlist.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("schema stays on the four shot fields", async () => {
  assert.deepEqual([...SHOT_FIELDS], ["#", "durationSec", "frame", "vo"]);
  const schema = JSON.parse(await readFile(path.join(root, "schemas/shotlist.schema.json"), "utf8")) as {
    items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
  };
  assert.equal(schema.items.additionalProperties, false);
  assert.deepEqual([...schema.items.required].sort(), [...SHOT_FIELDS].sort());
  assert.deepEqual(Object.keys(schema.items.properties).sort(), [...SHOT_FIELDS].sort());
});

test("shot schema rejects fields outside the four columns", () => {
  const parsed = shotSchema.safeParse({
    "#": 1,
    durationSec: 1,
    frame: "a",
    vo: "",
    lens: "wide",
  });
  assert.equal(parsed.success, false);
});

test("validate fails when the project folder has no shotlist", async () => {
  await withDir(async (dir) => {
    const cap = capture();
    const code = await run(["validate", "--project", dir], cap.io);
    assert.equal(code, 1);
    assert.match(cap.err(), /no shotlist/);
    assert.equal(cap.out(), "");
  });
});

test("validate fails on the empty shot list created by init", async () => {
  await withDir(async (dir) => {
    const init = capture();
    assert.equal(await run(["init", dir], init.io), 0);
    const cap = capture();
    const code = await run(["validate", "--project", dir], cap.io);
    assert.equal(code, 1);
    assert.match(cap.err(), /shotlist\.md: no shots/);
  });
});

test("validate accepts a markdown shot list and rejects an empty one", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "shotlist.md");
    await writeFile(
      file,
      ["| # | durationSec | frame | vo |", "|---|---|---|---|", "| 1 | 4 | 黄昏的港口 | 我们从水面开始。 |", ""].join("\n"),
    );
    const ok = capture();
    assert.equal(await run(["validate", "--project", dir], ok.io), 0);
    assert.match(ok.out(), /ok shotlist\.md \(1 shot\)/);
    assert.match(ok.out(), /#1 {2}4s {2}vo/);

    await writeFile(file, "| # | durationSec | frame | vo |\n|---|---|---|---|\n");
    const empty = capture();
    assert.equal(await run(["validate", "--project", dir], empty.io), 1);
    assert.match(empty.err(), /no shots/);
  });
});

test("validate accepts json, including an empty voice line", async () => {
  await withDir(async (dir) => {
    await writeFile(
      path.join(dir, "shotlist.json"),
      JSON.stringify([
        { "#": 1, durationSec: 2.5, frame: "码头上的灯", vo: "" },
        { "#": 2, durationSec: 1, frame: "水面", vo: "好" },
      ]),
    );
    const cap = capture();
    assert.equal(await run(["validate", "--project", dir], cap.io), 0);
    assert.match(cap.out(), /#1 {2}2\.5s {2}no vo/);
    assert.match(cap.out(), /#2 {2}1s {2}vo/);
  });
});

test("validate rejects duplicate numbers, bad duration, extra fields, and two shot lists", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "shotlist.json");
    await writeFile(
      file,
      JSON.stringify([
        { "#": 1, durationSec: 1, frame: "a", vo: "" },
        { "#": 1, durationSec: 1, frame: "b", vo: "" },
      ]),
    );
    const duplicate = capture();
    assert.equal(await run(["validate", "--project", dir], duplicate.io), 1);
    assert.match(duplicate.err(), /duplicate shot #1/);

    await writeFile(file, JSON.stringify([{ "#": 1, durationSec: 0, frame: "a", vo: "" }]));
    const duration = capture();
    assert.equal(await run(["validate", "--project", dir], duration.io), 1);
    assert.match(duration.err(), /durationSec must be a positive number/);

    await writeFile(file, JSON.stringify([{ "#": 1, durationSec: 1, frame: "a", vo: "", lens: "wide" }]));
    const extra = capture();
    assert.equal(await run(["validate", "--project", dir], extra.io), 1);
    assert.match(extra.err(), /unknown field lens/);

    await writeFile(path.join(dir, "shotlist.md"), "| # | durationSec | frame | vo |\n|---|---|---|---|\n");
    const both = capture();
    assert.equal(await run(["validate", "--project", dir], both.io), 1);
    assert.match(both.err(), /keep one/);
  });
});

test("parseShotlistData reports an empty list without throwing", () => {
  assert.deepEqual(parseShotlistData([], "shotlist.json"), []);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { helpText } from "../src/help.js";
import { readVersion } from "../src/version.js";
import {
  YCYAPI_GROUP_RATIO,
  YCYAPI_PER_CALL,
  YCYAPI_PRICE_CAPTURED,
  YCYAPI_PRICE_PAGE,
  YCYAPI_PRICE_SOURCE,
  YCYAPI_SEEDANCE_25A_GROUP,
  YCYAPI_YUAN_PER_OUTPUT_SECOND,
  roundYuan,
  ycyapiCost,
} from "../src/ycyapi/cost.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("seedance2.5-A bills output seconds by resolution and ignores reference video", () => {
  const rates = YCYAPI_YUAN_PER_OUTPUT_SECOND;
  assert.deepEqual(rates, { "480p": 0.36, "720p": 0.62, "1080p": 0.95 });
  for (const [resolution, rate] of Object.entries(rates)) {
    const plain = ycyapiCost({ wireModel: "seedance2.5-A", resolution, seconds: 4 });
    const withVideo = ycyapiCost({
      wireModel: "seedance2.5-A",
      resolution,
      seconds: 4,
      referenceVideos: 2,
      referenceVideoSeconds: 30,
    });
    assert.equal(plain.yuan, roundYuan(rate * 4), resolution);
    assert.deepEqual(withVideo, plain, resolution);
    assert.equal(plain.text.includes(`${resolution}, 4 output s`), true);
    assert.equal(plain.text.includes(YCYAPI_SEEDANCE_25A_GROUP), true);
  }
  const onePlusOne = ycyapiCost({
    wireModel: "seedance2.5-A",
    resolution: "720p",
    seconds: 1,
    referenceVideos: 1,
    referenceVideoSeconds: 1,
  });
  assert.equal(onePlusOne.yuan, 0.62);
  assert.equal(onePlusOne.text, "estimate: 0.62 yuan (seedance2.5-A 720p, 1 output s × 0.62 yuan/s, group 22-SD-2.5视频)");
  assert.notEqual(onePlusOne.yuan, roundYuan(0.62 * 2));
  const four = ycyapiCost({ wireModel: "seedance2.5-A", resolution: "720p", seconds: 4, group: "22-SD-2.5视频" });
  assert.equal(four.yuan, 2.48);
  assert.notEqual(four.yuan, roundYuan(0.62 * 0.1 * 4));
  assert.equal(ycyapiCost({ wireModel: "seedance2.5-A", resolution: "1080p", seconds: 15 }).yuan, 14.25);
  assert.equal(ycyapiCost({ wireModel: "seedance2.5-A", resolution: "480p", seconds: 30 }).yuan, 10.8);
});

test("per-call ycyapi models use model_price times the published group ratio", () => {
  for (const [model, row] of Object.entries(YCYAPI_PER_CALL)) {
    for (const group of row.groups) {
      const ratio = YCYAPI_GROUP_RATIO[group];
      assert.equal(typeof ratio, "number", group);
      const yuan = roundYuan(row.modelPrice * ratio!);
      const withVideo = ycyapiCost({
        wireModel: model,
        group,
        seconds: 30,
        resolution: "1080p",
        referenceVideos: 3,
        referenceVideoSeconds: 90,
      });
      const bare = ycyapiCost({ wireModel: model, ...(row.groups.length === 1 ? {} : { group }) });
      assert.equal(withVideo.yuan, yuan, `${model} ${group}`);
      assert.deepEqual(withVideo, bare, `${model} ${group}`);
      const unit = row.kind === "image" ? "1 image" : "1 call";
      assert.equal(withVideo.text, `estimate: ${formatExpected(yuan)} yuan (${model}, ${unit}, group ${group})`);
    }
  }
  assert.equal(ycyapiCost({ wireModel: "ya-sd25-30s", seconds: 4 }).yuan, 2);
  assert.equal(ycyapiCost({ wireModel: "ya-sd25-30s", seconds: 30, referenceVideos: 1, referenceVideoSeconds: 30 }).text, "estimate: 2.00 yuan (ya-sd25-30s, 1 call, group 22-SD-2.5视频)");
  assert.equal(ycyapiCost({ wireModel: "seedance-2.5" }).yuan, 0.32);
  assert.equal(ycyapiCost({ wireModel: "seedance2.5" }).yuan, 0.4);
  assert.equal(ycyapiCost({ wireModel: "seedance-2.0:i2v" }).yuan, 2.59998);
  assert.equal(ycyapiCost({ wireModel: "seedance-2.0:i2v" }).text, "estimate: 2.59998 yuan (seedance-2.0:i2v, 1 call, group 22-SD-2.0视频)");
  assert.equal(ycyapiCost({ wireModel: "gpt-image-2.5-flare" }).yuan, 0.01);
  assert.equal(ycyapiCost({ wireModel: "gpt-image-2.5-sunburst" }).yuan, 0.01);
  assert.equal(ycyapiCost({ wireModel: "gpt-image-4K" }).yuan, 0.03);
  assert.equal(ycyapiCost({ wireModel: "gpt-image-2", group: "20-GPT-特价生图" }).yuan, 0.01);
  assert.equal(ycyapiCost({ wireModel: "gpt-image-2", group: "20-GPT-图片" }).yuan, 0.04);
  assert.throws(() => ycyapiCost({ wireModel: "gpt-image-2" }), /needs --group/);
  assert.throws(() => ycyapiCost({ wireModel: "seedance2.5-A", resolution: "720p", seconds: 4, group: "20-GPT-特价生图" }), /not priced in group/);
  assert.throws(() => ycyapiCost({ wireModel: "seedance2.5-A", resolution: "4k", seconds: 4 }), /no price for resolution 4k/);
  assert.equal(ycyapiCost({ wireModel: "seedance2.5-custom", seconds: 4, referenceVideos: 1, referenceVideoSeconds: 8 }).text, "estimate: no published ycyapi price for seedance2.5-custom");
  assert.equal(ycyapiCost({ wireModel: "seedance2.5-custom" }).yuan, undefined);
});

function formatExpected(yuan: number): string {
  const [whole, frac = ""] = yuan.toFixed(6).replace(/0+$/, "").replace(/\.$/, "").split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

test("ycyapi docs name the price source and output-second rule", async () => {
  const priced = ["skills/lumen/references/seedance-2.5/SKILL.md", "README.md"];
  for (const file of priced) {
    const text = await readFile(path.join(root, file), "utf8");
    assert.match(text, new RegExp(YCYAPI_PRICE_SOURCE.replace(/[.]/g, "\\.")), file);
    assert.match(text, new RegExp(YCYAPI_PRICE_PAGE.replace(/[.]/g, "\\.")), file);
    assert.match(text, new RegExp(YCYAPI_PRICE_CAPTURED), file);
    assert.match(text, /0\.62/, file);
    assert.match(text, /参考视频/, file);
  }
  const skill = await readFile(path.join(root, "skills/lumen/SKILL.md"), "utf8");
  assert.match(skill, /2026-11-01/);
  assert.match(skill, /0\.62/);
  assert.match(skill, /参考视频不另收费/);
  assert.equal(/https?:\/\//.test(skill), false);
  assert.match(helpText(readVersion()), /seedance2\.5-A output seconds only/);
  assert.match(helpText(readVersion()), /Reference video seconds are not added/);
});

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

interface CallBody {
  value?: {
    omni_reference_task_type?: string;
    ratio?: string;
    duration?: number;
    content?: Array<{ role?: string }>;
  };
}

interface RunFile {
  status: string;
  modelId: string;
  params: {
    omniReferenceTaskType?: string;
    omniTaskTypeSpecified?: boolean;
    shape?: string;
  };
  calls: Array<{ url: string; body: CallBody }>;
}

async function bind(dir: string, model: string, provider: string, base: string, envName: string): Promise<void> {
  const cap = capture();
  assert.equal(
    await run(
      ["providers", "set", model, "--provider", provider, "--base-url", base, "--api-key-env", envName, "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

async function records(dir: string): Promise<RunFile[]> {
  const root = path.join(dir, ".lumen", "runs");
  const names = await readdir(root);
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(root, name, "record.json"), "utf8")) as RunFile));
}

const video = "video|https://cdn.example/src.mp4|false";
const image = "image|https://cdn.example/a.png|false";

test("seedance 2.5 edit and extend are checked before submit and sent on the haomao body", async () => {
  await withDir(async (dir) => {
    await bind(dir, "seedance-2.5", "haomao", "https://haomao.example/api/v3", "HAOMAO");
    await bind(dir, "seedance-2", "haomao", "https://haomao.example/api/v3", "HAOMAO");

    const edit = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "2.5", "--shape", "ReferenceVideo", "--task-type", "edit",
          "--prompt", "删除视频里的路人，改成空镜", "--duration", "-1", "--aspect-ratio", "adaptive",
          "--ref", video, "--project", dir,
        ],
        edit.io,
      ),
      0,
      edit.err(),
    );
    const extended = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "seedance-2.5", "--shape", "reference", "--task-type", "extend",
          "--prompt", "向后延长，角色继续往前走", "--duration", "6", "--aspect-ratio", "adaptive",
          "--ref", video, "--project", dir,
        ],
        extended.io,
      ),
      0,
      extended.err(),
    );
    const plain = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "seedance-2.5", "--shape", "reference",
          "--prompt", "沿用这张图的构图", "--duration", "5", "--aspect-ratio", "16:9",
          "--ref", image, "--project", dir,
        ],
        plain.io,
      ),
      0,
      plain.err(),
    );

    const found = await records(dir);
    const edited = found.find((record) => record.params.omniReferenceTaskType === "edit");
    const longer = found.find((record) => record.params.omniReferenceTaskType === "extend");
    const automatic = found.find((record) => record.params.omniTaskTypeSpecified === false);
    assert.equal(edited?.params.omniTaskTypeSpecified, true);
    assert.equal(edited?.calls[0]?.body.value?.omni_reference_task_type, "edit");
    assert.equal(edited?.calls[0]?.body.value?.ratio, "adaptive");
    assert.equal(edited?.calls[0]?.body.value?.duration, -1);
    assert.equal(edited?.calls[0]?.body.value?.content?.some((item) => item.role === "reference_video"), true);
    assert.equal(longer?.calls[0]?.body.value?.omni_reference_task_type, "extend");
    assert.equal(longer?.calls[0]?.body.value?.duration, 6);
    assert.equal(automatic?.params.omniReferenceTaskType, "auto");
    assert.equal(automatic?.calls[0]?.body.value?.omni_reference_task_type, "auto");
    assert.equal(automatic?.calls[0]?.body.value?.ratio, "16:9");

    const noVideo = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "seedance-2.5", "--shape", "reference", "--task-type", "edit",
          "--prompt", "改成空镜", "--duration", "-1", "--aspect-ratio", "adaptive",
          "--ref", image, "--project", dir,
        ],
        noVideo.io,
      ),
      1,
    );
    assert.match(noVideo.err(), /video reference/);
    const ratio = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "seedance-2.5", "--shape", "reference", "--task-type", "extend",
          "--prompt", "向后延长", "--duration", "6", "--aspect-ratio", "16:9",
          "--ref", video, "--project", dir,
        ],
        ratio.io,
      ),
      1,
    );
    assert.match(ratio.err(), /aspect-ratio adaptive/);
    const seconds = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "seedance-2.5", "--shape", "reference", "--task-type", "edit",
          "--prompt", "删除路人", "--duration", "5", "--aspect-ratio", "adaptive",
          "--ref", video, "--project", dir,
        ],
        seconds.io,
      ),
      1,
    );
    assert.match(seconds.err(), /duration -1/);
    const other = capture();
    assert.equal(
      await run(
        [
          "gen", "video", "--model", "seedance-2", "--shape", "reference", "--task-type", "edit",
          "--prompt", "删除路人", "--duration", "5", "--ref", video, "--project", dir,
        ],
        other.io,
      ),
      1,
    );
    assert.match(other.err(), /seedance-2\.5 shape reference/);
  });
});

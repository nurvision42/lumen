import assert from "node:assert/strict";
import test from "node:test";
import { haomaoWireModel, planVideo, uploadCall } from "../src/clients/seedance.js";

const base = { shape: "text", prompt: "p", duration: 5, resolution: "720p", aspectRatio: "16:9", generateAudio: false, webSearch: false, references: [] };

test("haomao seedance wire ids use the .0 names from /v1/models", () => {
  assert.equal(haomaoWireModel("seedance-2", undefined), "seedance-2.0");
  assert.equal(haomaoWireModel("seedance-2-fast", undefined), "seedance-2.0-fast");
  assert.equal(haomaoWireModel("seedance-2-mini", undefined), "seedance-2.0-mini");
  assert.equal(haomaoWireModel("seedance-2.5", undefined), "seedance-2.5");
});

test("modelAlias overrides the haomao wire model in submit and upload", () => {
  const binding = { provider: "haomao", apiKeyEnv: "K", baseUrl: "https://h.example/api/v3", modelAlias: "custom-x" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls = planVideo({ ...base, modelId: "seedance-2-mini" } as any, binding as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((calls[0]!.body as any).value.model, "custom-x");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plain = planVideo({ ...base, modelId: "seedance-2-fast" } as any, { ...binding, modelAlias: undefined } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((plain[0]!.body as any).value.model, "seedance-2.0-fast");
  assert.match(JSON.stringify(uploadCall(binding.baseUrl, haomaoWireModel("seedance-2", "custom-x"), "/tmp/a.png")), /custom-x/);
});

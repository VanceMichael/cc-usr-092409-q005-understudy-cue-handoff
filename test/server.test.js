import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.js";

test("健康接口返回可用状态", async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

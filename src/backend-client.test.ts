/**
 * @title Backend body tests
 * @notice medical-mcp writes SSE. A future backend may write JSON.
 *         The parser has to accept the body this gateway will actually see.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpHttpBody } from "./backend-client.js";

test("a JSON body is the response", () => {
  const parsed = parseMcpHttpBody(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    }),
  );
  assert.deepEqual(parsed.result, { tools: [] });
});

test("an SSE body yields the JSON-RPC response, not the event line", () => {
  const body = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}',
    "",
  ].join("\n");
  const parsed = parseMcpHttpBody(body);
  assert.deepEqual(parsed.result, {
    content: [{ type: "text", text: "ok" }],
  });
});

test("when several data lines arrive, the one with result or error wins", () => {
  const body = [
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"done"}]}}',
  ].join("\n");
  const parsed = parseMcpHttpBody(body);
  assert.equal(
    (parsed.result as { content: Array<{ text: string }> }).content[0]?.text,
    "done",
  );
});

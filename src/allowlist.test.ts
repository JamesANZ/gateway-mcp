/**
 * @title Allowlist tests
 * @notice A backend can advertise a tool this gateway must not publish.
 *         health-check is the stand-in for that case: it is a real medical
 *         tool, and it stays off the public list.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { publishTools } from "./allowlist.js";
import type { BackendConfig, BackendTool } from "./types.js";

const backend: BackendConfig = {
  id: "medical",
  url: "http://medical-mcp:3000/mcp",
  allow: ["list-sources", "search-drugs"],
};

const listed: BackendTool[] = [
  {
    name: "list-sources",
    description: "catalog",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "health-check",
    description: "pings upstreams and reports whether API keys are set",
  },
  {
    name: "search-drugs",
    description: "labels",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

test("only allowlisted tools are published, with the backend prefix", () => {
  const published = publishTools(backend, listed);
  assert.deepEqual(
    published.map((tool) => tool.publicName),
    ["medical__list-sources", "medical__search-drugs"],
  );
  assert.equal(
    published.some((tool) => tool.publicName.includes("health-check")),
    false,
  );
});

test("a schema that is not an object is replaced so tools/list still validates", () => {
  const published = publishTools(backend, [
    { name: "list-sources", inputSchema: { type: "string" } },
  ]);
  assert.deepEqual(published[0]?.inputSchema, {
    type: "object",
    properties: {},
  });
});

test("a configured tool the backend did not return is omitted", () => {
  const published = publishTools(backend, [
    { name: "list-sources", description: "catalog" },
  ]);
  assert.deepEqual(
    published.map((tool) => tool.publicName),
    ["medical__list-sources"],
  );
});

/**
 * @title Config tests
 * @notice The cluster URL in the file is what Kubernetes uses.
 *         Compose sets MEDICAL_MCP_URL and must replace that URL without
 *         editing the file. An empty variable must not wipe it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";

function writeConfig(yaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omni-config-"));
  const file = path.join(dir, "gateway.yaml");
  writeFileSync(file, yaml);
  return file;
}

const yaml = `
catalogRefreshMs: 30000
limits:
  requestTimeoutMs: 45000
  maxInFlight: 8
  rateLimit:
    perMinute: 30
    burst: 10
backends:
  - id: medical
    url: http://medical-mcp.default.svc.cluster.local:3000/mcp
    urlEnv: MEDICAL_MCP_URL
    allow:
      - list-sources
`;

test("the file URL is kept when the override is unset or blank", () => {
  const file = writeConfig(yaml);
  const unset = loadConfig(file, {});
  assert.equal(
    unset.backends[0]?.url,
    "http://medical-mcp.default.svc.cluster.local:3000/mcp",
  );
  const blank = loadConfig(file, { MEDICAL_MCP_URL: "  " });
  assert.equal(blank.backends[0]?.url, unset.backends[0]?.url);
});

test("a set override replaces the cluster URL", () => {
  const file = writeConfig(yaml);
  const config = loadConfig(file, {
    MEDICAL_MCP_URL: "http://medical-mcp:3000/mcp",
  });
  assert.equal(config.backends[0]?.url, "http://medical-mcp:3000/mcp");
  assert.equal(config.limits.burst, 10);
  assert.equal(config.limits.maxInFlight, 8);
});

test("duplicate backend ids are rejected", () => {
  const file = writeConfig(`
catalogRefreshMs: 1000
limits:
  requestTimeoutMs: 1000
  maxInFlight: 1
  rateLimit:
    perMinute: 1
    burst: 1
backends:
  - id: medical
    url: http://example.test/mcp
    allow: [list-sources]
  - id: medical
    url: http://example.test/other
    allow: [list-sources]
`);
  assert.throws(() => loadConfig(file, {}), /Duplicate backend id/);
});

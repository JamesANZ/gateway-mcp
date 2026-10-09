/**
 * @title Live gateway check
 * @notice Run this against a gateway that is already listening.
 * @dev Default URL is the Compose and port-forward address. The script uses
 *      the official MCP client, which is the same Streamable HTTP path Cursor
 *      uses: GET (expects 405), initialize, tools/list, tools/call.
 *      It does not spend the rate-limit burst unless you pass --rate-limit.
 *      Spending it would make the next Cursor call wait for a refill.
 *
 *      Usage:
 *        node scripts/verify-gateway.mjs
 *        node scripts/verify-gateway.mjs --rate-limit
 *        GATEWAY_URL=http://127.0.0.1:8090/mcp node scripts/verify-gateway.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.GATEWAY_URL ?? "http://127.0.0.1:8090/mcp";
const checkRateLimit = process.argv.includes("--rate-limit");

/**
 * @notice Fail the process with one sentence.
 * @param message What was wrong.
 */
function fail(message) {
  console.error(message);
  process.exit(1);
}

const origin = endpoint.replace(/\/mcp\/?$/, "");

/**
 * @notice The process can be listening before /readyz flips to 200.
 *         Compose marks the container healthy on that URL; this loop is
 *         the same wait when the script starts a moment too early.
 */
let readyResponse;
for (let attempt = 1; attempt <= 15; attempt += 1) {
  try {
    readyResponse = await fetch(`${origin}/readyz`);
    if (readyResponse.ok) {
      break;
    }
  } catch {
    readyResponse = undefined;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const live = await fetch(`${origin}/healthz`);
if (!live.ok) {
  fail(`/healthz returned ${live.status}`);
}
if (!readyResponse?.ok) {
  fail(
    `/readyz did not return 200. The medical backend is probably not ready.`,
  );
}

const get = await fetch(endpoint);
if (get.status !== 405) {
  fail(`GET /mcp returned ${get.status}, expected 405`);
}
if (get.status === 401 || get.status === 403) {
  fail("GET /mcp returned an authentication status. This gateway must not.");
}

const transport = new StreamableHTTPClientTransport(new URL(endpoint));
const client = new Client({ name: "omni-verify", version: "0.1.0" });
await client.connect(transport);

const listed = await client.listTools();
const names = listed.tools.map((tool) => tool.name).sort();
if (!names.includes("medical__list-sources")) {
  fail(`tools/list is missing medical__list-sources: ${names.join(", ")}`);
}
for (const hidden of [
  "health-check",
  "medical__health-check",
  "get-cache-stats",
  "medical__get-cache-stats",
  "medical__search-google-scholar",
  "medical__rank-search-hits",
  "medical__research-medical-topic",
]) {
  if (names.includes(hidden)) {
    fail(`tools/list published a held-back tool: ${hidden}`);
  }
}

const result = await client.callTool({
  name: "medical__list-sources",
  arguments: {},
});
const text = Array.isArray(result.content)
  ? result.content.map((part) => ("text" in part ? part.text : "")).join("\n")
  : "";
if (!text || result.isError) {
  fail(`medical__list-sources did not return text: ${JSON.stringify(result)}`);
}

let hiddenRejected = false;
try {
  await client.callTool({
    name: "medical__health-check",
    arguments: {},
  });
} catch (error) {
  hiddenRejected = true;
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|oauth/i.test(message)) {
    fail(`hidden tool call looked like an auth challenge: ${message}`);
  }
}
if (!hiddenRejected) {
  fail("medical__health-check was callable. The allowlist did not reject it.");
}

if (checkRateLimit) {
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 100 + i,
        method: "tools/call",
        params: { name: "medical__list-sources", arguments: {} },
      }),
    });
    if (response.status === 401 || response.status === 403) {
      fail("rate-limit check received an authentication status");
    }
    if (response.status === 429) {
      limited = true;
      break;
    }
  }
  if (!limited) {
    fail("twelve tool calls never returned 429. The burst of 10 did not hold.");
  }
  console.log("rate limit returned 429");
}

await client.close();
console.log(`ok ${names.length} tools, called medical__list-sources`);
console.log(names.join("\n"));

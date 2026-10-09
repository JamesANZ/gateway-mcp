/**
 * @title HTTP gateway tests
 * @notice A fake backend stands in for medical-mcp. The assertions are the
 *         ones a real client depends on: initialize names this gateway,
 *         no session header, hidden tools are absent and not callable,
 *         a public call is forwarded under the backend's own tool name,
 *         GET is 405, and the process does not answer 401 or 403.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { FetchBackendClient } from "./backend-client.js";
import { ToolCatalog } from "./catalog.js";
import { startHttpServer } from "./http.js";
import type { GatewayConfig } from "./types.js";

interface JsonRpc {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { code?: number; message?: string };
}

/**
 * @notice Start a backend that speaks the same SSE shape as medical-mcp.
 * @returns The MCP URL plus the last tools/call name it was asked to run.
 * @dev /readyz is what the gateway probes. tools/list includes a hidden tool
 *      so the test can prove the allowlist removed it.
 */
async function startBackend(): Promise<{
  url: string;
  lastCall: () => string | undefined;
  close: () => Promise<void>;
}> {
  let lastCall: string | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/readyz" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        method?: string;
        params?: { name?: string };
      };
      if (body.method === "tools/list") {
        sse(res, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              {
                name: "list-sources",
                description: "catalog",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "health-check",
                description: "admin",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
        return;
      }
      if (body.method === "tools/call") {
        lastCall = body.params?.name;
        sse(res, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: `ran ${body.params?.name}` }],
          },
        });
        return;
      }
      res.writeHead(400);
      res.end();
    });
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("backend did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    lastCall: () => lastCall,
    close: () => close(server),
  };
}

/**
 * @notice Write one SSE message the gateway parser accepts.
 * @param res Backend response.
 * @param payload JSON-RPC object.
 */
function sse(res: import("node:http").ServerResponse, payload: unknown): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * @notice POST /mcp the way an MCP client does, and parse SSE or JSON.
 * @param url Gateway MCP URL.
 * @param message JSON-RPC request.
 * @returns Status, selected headers, and the parsed body.
 */
async function postMcp(
  url: string,
  message: unknown,
): Promise<{ status: number; headers: Headers; body: JsonRpc }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: parse(text),
  };
}

/**
 * @notice Same parser the backend client uses, copied small so this test
 *         does not hide a gateway bug behind the production parser.
 * @param text HTTP body.
 */
function parse(text: string): JsonRpc {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpc;
  }
  const line = trimmed.split("\n").find((item) => item.startsWith("data: "));
  if (!line) {
    throw new Error(`No JSON in body: ${text}`);
  }
  return JSON.parse(line.slice("data: ".length)) as JsonRpc;
}

test("the gateway publishes allowlisted tools and forwards one call", async () => {
  const backend = await startBackend();
  const config: GatewayConfig = {
    catalogRefreshMs: 60_000,
    limits: {
      requestTimeoutMs: 5_000,
      maxInFlight: 8,
      perMinute: 30,
      burst: 10,
    },
    backends: [
      {
        id: "medical",
        url: backend.url,
        allow: ["list-sources"],
      },
    ],
  };
  const client = new FetchBackendClient();
  const catalog = new ToolCatalog(
    config.backends,
    config.catalogRefreshMs,
    client,
  );
  await catalog.refresh();
  const gateway = await startHttpServer(
    { config, catalog, client },
    { host: "127.0.0.1", port: 0 },
  );

  try {
    const live = await fetch(gateway.url.replace(/\/mcp$/, "/healthz"));
    const ready = await fetch(gateway.url.replace(/\/mcp$/, "/readyz"));
    assert.equal(live.status, 200);
    assert.equal(ready.status, 200);

    const get = await fetch(gateway.url);
    assert.equal(get.status, 405);
    assert.notEqual(get.status, 401);
    assert.notEqual(get.status, 403);

    const initialized = await postMcp(gateway.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "http-test", version: "0" },
      },
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.result?.serverInfo?.name, "omni-mcp");
    assert.equal(initialized.headers.get("mcp-session-id"), null);

    const listed = await postMcp(gateway.url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const names = listed.body.result?.tools?.map((tool) => tool.name) ?? [];
    assert.deepEqual(names, ["medical__list-sources"]);
    assert.equal(names.includes("medical__health-check"), false);
    assert.equal(names.includes("health-check"), false);

    const called = await postMcp(gateway.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "medical__list-sources", arguments: {} },
    });
    assert.equal(called.status, 200);
    assert.equal(called.body.result?.content?.[0]?.text, "ran list-sources");
    assert.equal(backend.lastCall(), "list-sources");

    const hidden = await postMcp(gateway.url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "medical__health-check", arguments: {} },
    });
    assert.notEqual(hidden.status, 401);
    assert.notEqual(hidden.status, 403);
    assert.equal(hidden.body.error?.code, -32602);
    assert.equal(backend.lastCall(), "list-sources");
  } finally {
    await gateway.close();
    await backend.close();
  }
});

test("a tool call past the configured burst is rejected with 429", async () => {
  const backend = await startBackend();
  const config: GatewayConfig = {
    catalogRefreshMs: 60_000,
    limits: {
      requestTimeoutMs: 5_000,
      maxInFlight: 8,
      perMinute: 30,
      burst: 2,
    },
    backends: [
      {
        id: "medical",
        url: backend.url,
        allow: ["list-sources"],
      },
    ],
  };
  const client = new FetchBackendClient();
  const catalog = new ToolCatalog(
    config.backends,
    config.catalogRefreshMs,
    client,
  );
  await catalog.refresh();
  const gateway = await startHttpServer(
    { config, catalog, client },
    { host: "127.0.0.1", port: 0 },
  );

  try {
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "medical__list-sources", arguments: {} },
    };
    const first = await postMcp(gateway.url, call);
    const second = await postMcp(gateway.url, call);
    const third = await postMcp(gateway.url, call);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.equal(third.body.error?.message, "Rate limit exceeded");
    assert.notEqual(third.status, 401);
    assert.notEqual(third.status, 403);
  } finally {
    await gateway.close();
    await backend.close();
  }
});

test("a body that is not JSON is 400, not an authentication error", async () => {
  const backend = await startBackend();
  const config: GatewayConfig = {
    catalogRefreshMs: 60_000,
    limits: {
      requestTimeoutMs: 5_000,
      maxInFlight: 2,
      perMinute: 30,
      burst: 10,
    },
    backends: [{ id: "medical", url: backend.url, allow: ["list-sources"] }],
  };
  const client = new FetchBackendClient();
  const catalog = new ToolCatalog(
    config.backends,
    config.catalogRefreshMs,
    client,
  );
  const gateway = await startHttpServer(
    { config, catalog, client },
    { host: "127.0.0.1", port: 0 },
  );
  try {
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 403);
  } finally {
    await gateway.close();
    await backend.close();
  }
});

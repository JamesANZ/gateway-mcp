/**
 * @title HTTP server
 * @notice The only public MCP endpoint. Clients POST JSON-RPC to `/mcp`.
 * @dev Each POST builds its own SDK server and transport, then throws them
 *      away. medical-mcp learned this the hard way: the SDK stores one
 *      transport on a server object, so a shared server sends the second
 *      client's reply to the first client. The catalog, the rate-limit
 *      buckets, and the in-flight counter stay shared. Those are process
 *      state. The MCP server object is not.
 *
 *      sessionIdGenerator is undefined. The response therefore has no
 *      Mcp-Session-Id header. Any replica can handle the next POST. Do not
 *      "fix" this by generating a session id unless you also add sticky
 *      sessions. This version has no session store.
 *
 *      GET and DELETE return 405. The spec says a server with no
 *      server-initiated stream does that, and the official client treats
 *      405 as "POST only". Sampling and elicitation need that stream, so
 *      they are unsupported. That is what makes the gateway stateless.
 *
 *      This file never writes HTTP 401 or 403. Those statuses make Claude
 *      Code and VS Code start an OAuth flow. Rate limits and the concurrency
 *      cap use 429. Backend failures become JSON-RPC errors on the SDK's
 *      normal 200 SSE response.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Server as HttpServer } from "node:http";
import type { BackendClient } from "./backend-client.js";
import type { ToolCatalog } from "./catalog.js";
import { forwardToolCall } from "./forward.js";
import { clientAddress, InFlightGate, TokenBucket } from "./limits.js";
import { log } from "./log.js";
import type { GatewayConfig } from "./types.js";

/**
 * @notice Name and version advertised in the initialize result.
 * @dev Clients show this name in their MCP settings. It is the gateway,
 *      not medical-mcp. The version tracks this repo's package.json.
 */
const SERVER_INFO = { name: "omni-mcp", version: "0.1.0" };

/**
 * @notice How long /readyz will wait for one backend probe.
 * @dev The Kubernetes probe timeout is 2 seconds. This stays under that so
 *      a slow backend makes us NotReady instead of making the probe itself time out.
 */
const READY_PROBE_MS = 1_500;

/**
 * @notice Pieces the listener needs. Tests build them around a fake backend.
 */
export interface GatewayRuntime {
  config: GatewayConfig;
  catalog: ToolCatalog;
  client: BackendClient;
}

/**
 * @notice A listening gateway.
 * @param server Node HTTP server. Close it to stop accepting.
 * @param url Public base the tests POST to, including `/mcp`.
 * @param close Stops the catalog timer and the listener.
 */
export interface RunningGateway {
  server: HttpServer;
  url: string;
  close: () => Promise<void>;
}

/**
 * @notice Bind the gateway.
 * @param runtime Catalog and client already constructed.
 * @param options.host Interface. `0.0.0.0` inside a container so the
 *        Service can reach it. `127.0.0.1` is only for a local process test.
 * @param options.port TCP port. `0` asks the OS for a free port (tests).
 * @param options.handleSignals When true, SIGTERM and SIGINT stop the listener.
 *        index.ts sets this. Tests leave it false so a signal is not stolen.
 * @returns The bound server.
 */
export async function startHttpServer(
  runtime: GatewayRuntime,
  options: { host?: string; port?: number; handleSignals?: boolean } = {},
): Promise<RunningGateway> {
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.PORT ?? 8080);
  let accepting = true;

  const rateLimit = new TokenBucket(runtime.config.limits);
  const inFlight = new InFlightGate(runtime.config.limits.maxInFlight);

  const app = express();
  // @notice Browser MCP inspectors send a preflight. Credentialed CORS is off
  //         because this server has no cookies and no Authorization scheme.
  app.use(cors());
  app.options("/mcp", cors());
  // @notice 256kb is enough for the allowlisted tools. rank-search-hits, which
  //         posts a pile of abstracts, is not on the allowlist. A larger body
  //         is rejected with 413 before it reaches a backend.
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    // @notice Liveness is "is this process alive?". It does not call medical-mcp.
    //         If it did, a backend outage would make Kubernetes kill the gateway.
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    // @notice Readiness is "should new clients be sent here?".
    //         During shutdown the answer is no, even if the process is alive.
    //         Otherwise every configured backend must answer /readyz. With one
    //         backend that means medical-mcp is accepting. A failed check
    //         removes this Pod from the Service. It does not restart it.
    if (!accepting) {
      res.status(503).json({ status: "shutting-down" });
      return;
    }
    // @notice An empty catalog means the last tools/list failed or has not
    //         succeeded yet. Sending clients there would show zero tools.
    //         Liveness stays ok so Kubernetes does not restart us for a
    //         backend that is simply not up yet.
    if (runtime.catalog.list().length === 0) {
      res.status(503).json({ status: "catalog-empty" });
      return;
    }
    const ready = await backendsReady(runtime);
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? "ready" : "backend-unavailable" });
  });

  // @notice Standalone SSE stream. We do not offer one. 405 is the spec's answer.
  app.get("/mcp", (_req, res) => {
    refuseMethod(res);
  });
  app.delete("/mcp", (_req, res) => {
    refuseMethod(res);
  });

  app.post("/mcp", async (req, res) => {
    const release = gateToolCall(req, res, rateLimit, inFlight);
    if (!release) {
      return;
    }
    const mcp = createGatewayServer(runtime);
    const transport = new StreamableHTTPServerTransport({
      // @notice undefined disables session ids. See the file header.
      sessionIdGenerator: undefined,
    });

    let closed = false;
    const closePair = () => {
      if (closed) {
        return;
      }
      closed = true;
      release();
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    };
    // @notice finish: the response was sent, so the slot can be reused while
    //         the TCP connection stays open (HTTP keep-alive).
    //         close: the client hung up first. closePair is idempotent.
    res.on("finish", closePair);
    res.on("close", closePair);

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log({
        event: "mcp_request_failed",
        message: error instanceof Error ? error.message : "unknown",
      });
      if (!res.headersSent) {
        // @notice 500, not 401. The body is still JSON-RPC so a client that
        //         parses the body can show the message.
        res.status(500).json({
          jsonrpc: "2.0",
          id: requestId(req.body),
          error: {
            code: -32603,
            message: "Gateway failed before a backend call",
          },
        });
      }
      closePair();
    }
  });

  app.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      const typed = error as { type?: string; status?: number };
      if (typed?.type === "entity.too.large" || typed?.status === 413) {
        res.status(413).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body is too large" },
        });
        return;
      }
      if (error instanceof SyntaxError) {
        res.status(400).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Request body is not JSON" },
        });
        return;
      }
      next(error);
    },
  );

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening));
    listening.on("error", reject);
  });

  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  log({ event: "listening", host, port: boundPort });

  const close = async () => {
    accepting = false;
    runtime.catalog.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };

  if (options.handleSignals) {
    installSignals(close);
  }

  return {
    server,
    url: `http://127.0.0.1:${boundPort}/mcp`,
    close,
  };
}

/**
 * @notice Build the MCP server object for a single POST.
 * @param runtime Shared catalog and client. The server object is not shared.
 * @returns A server with tools/list and tools/call handlers.
 * @dev initialize, ping, and the initialized notification are implemented
 *      by the SDK. We do not register prompts, resources, or sampling.
 *      Capabilities advertise tools only, so clients will not ask for those.
 */
function createGatewayServer(runtime: GatewayRuntime): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "Tools are named <backend>__<tool>. Only the gateway allowlist is callable. " +
      "This server does not keep a session.",
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: runtime.catalog.list(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    return forwardToolCall(
      runtime.catalog,
      runtime.client,
      runtime.config.limits.requestTimeoutMs,
      request.params.name,
      args as Record<string, unknown>,
    );
  });

  return server;
}

/**
 * @notice Apply the tool-call limits, or reject the POST.
 * @param req Incoming request. Only `tools/call` is limited.
 * @param res Response, written only when the call is rejected.
 * @param rateLimit Per-address token bucket.
 * @param inFlight Process-wide concurrency cap.
 * @returns A function that releases the in-flight slot, or null if the
 *          response was already finished with 429.
 * @dev initialize and tools/list are not limited. They do not call upstream
 *      medical APIs; tools/list reads the catalog snapshot.
 *      A concurrency rejection refunds the token so a busy process does not
 *      also empty the caller's bucket.
 */
function gateToolCall(
  req: Request,
  res: Response,
  rateLimit: TokenBucket,
  inFlight: InFlightGate,
): (() => void) | null {
  if (!isToolCall(req.body)) {
    return () => {};
  }
  const key = clientAddress(req.socket.remoteAddress);
  const tool = toolName(req.body);
  if (!rateLimit.tryTake(key)) {
    log({ event: "rate_limited", tool, client: key });
    writeLimit(res, requestId(req.body), "Rate limit exceeded");
    return null;
  }
  if (!inFlight.tryEnter()) {
    rateLimit.refund(key);
    log({ event: "concurrency_limited", tool, client: key });
    writeLimit(res, requestId(req.body), "Too many tool calls in flight");
    return null;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    inFlight.leave();
  };
}

/**
 * @notice 405 for methods this endpoint does not implement.
 * @param res Response to finish.
 * @dev Allow tells the client which method works. Status is 405, never 401.
 */
function refuseMethod(res: Response): void {
  res
    .status(405)
    .set("Allow", "POST")
    .json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32601,
        message:
          "This endpoint accepts POST. There is no server-initiated SSE stream.",
      },
    });
}

/**
 * @notice JSON-RPC error used for both limit rejections.
 * @param res Response to finish.
 * @param id Client request id, or null.
 * @param message Sentence the client can show.
 * @dev Status 429 is the HTTP signal. The body is JSON-RPC so a caller that
 *      only prints the body still sees why.
 */
function writeLimit(
  res: Response,
  id: number | string | null,
  message: string,
): void {
  res.status(429).json({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message },
  });
}

/**
 * @notice True when this POST is a tools/call.
 * @param body Parsed JSON. Notifications and batches are not tool calls.
 */
function isToolCall(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { method?: unknown }).method === "tools/call"
  );
}

/**
 * @notice Tool name from a tools/call body, for the log line only.
 * @param body Parsed JSON.
 * @returns The name, or `"unknown"` when the body is not a tool call.
 */
function toolName(body: unknown): string {
  const params = (body as { params?: { name?: unknown } }).params;
  return typeof params?.name === "string" ? params.name : "unknown";
}

/**
 * @notice JSON-RPC id to echo on an error we generate ourselves.
 * @param body Parsed JSON.
 * @returns The id, or null when the client did not send one.
 */
function requestId(body: unknown): number | string | null {
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id === "number" || typeof id === "string") {
    return id;
  }
  return null;
}

/**
 * @notice Ask every backend whether it is ready.
 * @param runtime Config supplies the `/mcp` URLs. Readiness is `/readyz` on the same origin.
 * @returns True only when every backend answers 200.
 * @dev One unready backend fails the gateway probe. Publishing tools we cannot
 *      route would look like a successful connect followed by failing calls.
 */
async function backendsReady(runtime: GatewayRuntime): Promise<boolean> {
  const checks = await Promise.all(
    runtime.config.backends.map(async (backend) => {
      const readyUrl = backend.url.replace(/\/mcp\/?$/, "/readyz");
      try {
        const response = await fetch(readyUrl, {
          signal: AbortSignal.timeout(READY_PROBE_MS),
        });
        return response.ok;
      } catch {
        return false;
      }
    }),
  );
  return checks.every(Boolean);
}

/**
 * @notice Stop accepting on SIGTERM and SIGINT, then exit.
 * @param close Closes the listener and the catalog timer.
 * @dev Kubernetes sends SIGTERM and waits terminationGracePeriodSeconds.
 *      We mark readiness false by closing. The ten-second force-exit is
 *      inside the 15-second grace period in the Deployment.
 */
function installSignals(close: () => Promise<void>): void {
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log({ event: "shutdown", signal });
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log({
          event: "shutdown_failed",
          message: error instanceof Error ? error.message : "unknown",
        });
        process.exit(1);
      });
    setTimeout(() => {
      log({ event: "shutdown_timeout" });
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

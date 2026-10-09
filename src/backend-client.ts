/**
 * @title Backend HTTP client
 * @notice Sends one JSON-RPC message to a backend and reads one response.
 * @dev medical-mcp answers each POST on its own. It does not require a prior
 *      initialize on the same connection, because that server builds a new
 *      MCP server object per request and does not issue a session id.
 *      This client therefore does not remember sessions either. Any gateway
 *      replica can forward the next call.
 *
 *      Responses may be a JSON body or one Server-Sent Events message.
 *      medical-mcp uses the SSE form. Both are accepted so a future backend
 *      that enables JSON responses still works.
 */

import { log } from "./log.js";
import type { BackendTool, JsonRpcResponse } from "./types.js";

/**
 * @notice Error from a backend that is not a normal tool result.
 * @param status HTTP status, when the failure was at the HTTP layer.
 * @param timedOut True when the deadline fired before headers arrived.
 * @dev `timedOut` is separate from a backend JSON-RPC error. The forwarder
 *      tells the client "timed out" only for the first case. A tool that
 *      returns isError is the tool working.
 */
export class BackendError extends Error {
  /**
   * @param message Short text safe to log. Do not put secrets in it.
   * @param status HTTP status from the backend, if any.
   * @param timedOut Whether AbortSignal fired.
   */
  constructor(
    message: string,
    readonly status?: number,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

/**
 * @notice What the catalog and the forwarder need from a backend.
 * @dev Tests substitute a fake. Production uses FetchBackendClient.
 */
export interface BackendClient {
  /**
   * @notice POST tools/list and return the tool array.
   * @param url Backend `/mcp` URL.
   * @param timeoutMs Deadline for this list call. Shorter than a tool call.
   */
  listTools(url: string, timeoutMs: number): Promise<BackendTool[]>;

  /**
   * @notice POST tools/call and return the JSON-RPC result object.
   * @param url Backend `/mcp` URL.
   * @param name Backend tool name, without the public prefix.
   * @param args Arguments the client sent. Not logged.
   * @param timeoutMs Deadline from limits.requestTimeoutMs.
   */
  callTool(
    url: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown>;
}

/**
 * @notice Backend client that uses the platform fetch.
 */
export class FetchBackendClient implements BackendClient {
  /**
   * @inheritdoc
   * @dev A failed list is thrown. The catalog catches it and keeps the
   *      previous list for that backend, so one blip does not empty tools/list.
   */
  async listTools(url: string, timeoutMs: number): Promise<BackendTool[]> {
    const response = await postJsonRpc(
      url,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      timeoutMs,
    );
    const result = asRecord(response.result);
    const tools = result?.tools;
    if (!Array.isArray(tools)) {
      throw new BackendError("Backend tools/list did not return tools");
    }
    return tools.map(readTool);
  }

  /**
   * @inheritdoc
   * @dev The returned value is the MCP result object (`content`, `isError`),
   *      not the JSON-RPC envelope. The forwarder passes it to the client.
   */
  async callTool(
    url: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const response = await postJsonRpc(
      url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      timeoutMs,
    );
    if (response.error) {
      throw new BackendError(
        response.error.message || "Backend rejected the tool call",
      );
    }
    return response.result;
  }
}

/**
 * @notice POST one JSON-RPC message and parse JSON or SSE.
 * @param url Backend endpoint.
 * @param message JSON-RPC request. One message, not a batch.
 * @param timeoutMs Abort deadline.
 * @returns The parsed response object.
 * @dev HTTP 401 and 403 from a backend are turned into BackendError.
 *      This process must not answer the public client with those statuses:
 *      Claude Code and VS Code treat them as "start OAuth". The HTTP layer
 *      maps BackendError onto a JSON-RPC error with status 200 via the SDK.
 */
export async function postJsonRpc(
  url: string,
  message: unknown,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new BackendError(
      timedOut ? "Backend timed out" : "Backend connection failed",
      undefined,
      timedOut,
    );
  }

  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    log({
      event: "backend_auth_status",
      status: response.status,
      url,
    });
    throw new BackendError(
      "Backend returned an authentication status; the gateway does not use OAuth",
      response.status,
    );
  }
  if (!response.ok) {
    throw new BackendError(`Backend HTTP ${response.status}`, response.status);
  }
  return parseMcpHttpBody(text);
}

/**
 * @notice Pull one JSON-RPC response out of a backend body.
 * @param text Raw HTTP body.
 * @returns Parsed object that has `result` or `error`.
 * @dev SSE frames look like `data: {json...}`. Several data lines can appear
 *      if the server streams progress. The response is the last line that
 *      carries `result` or `error`. A body that is already JSON is parsed whole.
 */
export function parseMcpHttpBody(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }

  const messages: JsonRpcResponse[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    messages.push(JSON.parse(payload) as JsonRpcResponse);
  }

  const response = [...messages]
    .reverse()
    .find(
      (message) => message.result !== undefined || message.error !== undefined,
    );
  if (!response) {
    throw new BackendError("Backend body had no JSON-RPC response");
  }
  return response;
}

/**
 * @notice Read the fields the catalog needs from one tools/list entry.
 * @param value One element of `result.tools`. Unknown shapes become a tool
 *        with an empty name, which the allowlist will not publish.
 */
function readTool(value: unknown): BackendTool {
  const record = asRecord(value);
  const name = typeof record?.name === "string" ? record.name : "";
  const description =
    typeof record?.description === "string" ? record.description : undefined;
  return {
    name,
    description,
    inputSchema: record?.inputSchema,
  };
}

/**
 * @notice Narrow unknown JSON to a string-keyed object.
 * @param value Parsed JSON.
 * @returns The object, or null for arrays and primitives.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

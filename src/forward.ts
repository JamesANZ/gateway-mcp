/**
 * @title Tool-call forwarder
 * @notice Turns a public tools/call into one backend tools/call.
 * @dev The gateway does not run medical code. It checks the catalog, strips
 *      the prefix, and POSTs. Arguments are forwarded as the client sent them
 *      after the SDK parsed the JSON object. They are not logged.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { BackendError, type BackendClient } from "./backend-client.js";
import type { ToolCatalog } from "./catalog.js";
import { log } from "./log.js";

/**
 * @notice MCP tool result the SDK will serialize for the client.
 * @dev `content` is what Cursor and Claude Code show. `isError` marks a tool
 *      that ran and reported failure, which is different from a JSON-RPC error.
 *      Backend results are passed through when they already have this shape.
 */
export interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * @notice Route one public tool call.
 * @param catalog Current allowlisted snapshot.
 * @param client Backend HTTP client.
 * @param timeoutMs limits.requestTimeoutMs.
 * @param publicName Name the client called.
 * @param args Arguments object. Empty when the client omitted it.
 * @returns The backend's tool result.
 * @dev Unknown names, including hidden tools, throw InvalidParams with one
 *      sentence that does not say whether the backend has the tool.
 *      A timeout throws RequestTimeout. Anything else the backend failed at
 *      becomes InternalError. The message names the backend id, not the URL.
 */
export async function forwardToolCall(
  catalog: ToolCatalog,
  client: BackendClient,
  timeoutMs: number,
  publicName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const started = Date.now();
  const route = catalog.resolve(publicName);
  if (!route) {
    log({
      event: "tool_call",
      tool: publicName,
      status: "rejected",
      latencyMs: Date.now() - started,
    });
    throw new McpError(
      ErrorCode.InvalidParams,
      "Unknown tool. This gateway only publishes its allowlist.",
    );
  }

  try {
    const result = await client.callTool(
      route.backend.url,
      route.toolName,
      args,
      timeoutMs,
    );
    log({
      event: "tool_call",
      tool: publicName,
      backend: route.backend.id,
      backendTool: route.toolName,
      status: "ok",
      latencyMs: Date.now() - started,
    });
    return asToolResult(result);
  } catch (error) {
    const timedOut = error instanceof BackendError && error.timedOut;
    log({
      event: "tool_call",
      tool: publicName,
      backend: route.backend.id,
      backendTool: route.toolName,
      status: timedOut ? "timeout" : "error",
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : "unknown",
    });
    if (timedOut) {
      throw new McpError(
        ErrorCode.RequestTimeout,
        `Backend ${route.backend.id} timed out`,
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Backend ${route.backend.id} failed`,
    );
  }
}

/**
 * @notice Accept a backend result only when it can be shown to a client.
 * @param result JSON-RPC `result` from the backend.
 * @returns The same object when it has a content array.
 * @dev A backend that returns a bare string would not satisfy the SDK.
 *      Wrapping it keeps the client path uniform. We do not invent content
 *      for null; that is a backend bug and becomes an internal error.
 */
function asToolResult(result: unknown): ToolResult {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return result as ToolResult;
  }
  throw new BackendError("Backend tool result had no content");
}

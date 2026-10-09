/**
 * @title Shared gateway types
 * @notice Shapes passed between config, the catalog, and the backend client.
 * @dev These are not the MCP SDK's wire types. The SDK types stay at the HTTP
 *      edge so a backend schema change does not force every module to import it.
 */

/**
 * @notice One backend process this gateway is willing to call.
 * @param id Stable prefix for public tool names. Not a hostname.
 * @param url Streamable HTTP endpoint, including the `/mcp` path.
 * @param urlEnv Optional environment variable that replaces `url` when set.
 *        Compose sets it. The Kubernetes manifest does not.
 * @param allow Backend tool names to publish. Absent names are denied.
 */
export interface BackendConfig {
  id: string;
  url: string;
  urlEnv?: string;
  allow: string[];
}

/**
 * @notice Process-local limits. They do not coordinate across replicas.
 * @param requestTimeoutMs Deadline for one tools/call forwarded to a backend.
 * @param maxInFlight Cap on tools/call handlers running in this process.
 * @param perMinute Refill rate of each client's token bucket.
 * @param burst Maximum tokens a client may hold. This is the short burst.
 */
export interface LimitConfig {
  requestTimeoutMs: number;
  maxInFlight: number;
  perMinute: number;
  burst: number;
}

/**
 * @notice File contents after validation and environment overrides.
 */
export interface GatewayConfig {
  catalogRefreshMs: number;
  limits: LimitConfig;
  backends: BackendConfig[];
}

/**
 * @notice A tool as a backend described it on tools/list, before allowlisting.
 * @param name Backend tool name, for example `list-sources`.
 * @param description Text the backend asks clients to show.
 * @param inputSchema JSON Schema the backend published. May be absent.
 */
export interface BackendTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * @notice A tool this gateway is willing to show and call.
 * @param backendId Which configured backend owns the tool.
 * @param backendToolName Name to send in the backend tools/call.
 * @param publicName Name the client sees, `medical__list-sources`.
 * @param description Copied from the backend when it sent one.
 * @param inputSchema JSON Schema passed through to the client.
 */
export interface PublicTool {
  backendId: string;
  backendToolName: string;
  publicName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * @notice One JSON-RPC response, whether the backend sent JSON or an SSE frame.
 * @param result Present on success. Tool calls put the MCP content object here.
 * @param error Present when the backend rejected the request.
 */
export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

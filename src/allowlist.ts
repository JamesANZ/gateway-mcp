/**
 * @title Allowlist
 * @notice Decides which backend tools become public tools.
 * @dev Default is deny: a tool the backend adds next week stays hidden until
 *      its name is written into config/gateway.yaml. Hiding a tool here does
 *      not remove it from medical-mcp. A port-forward to that Service still
 *      sees the full list. The public URL is this gateway, so the allowlist
 *      is what anonymous callers can reach.
 */

import { log } from "./log.js";
import { isLegalPublicName, publicToolName } from "./names.js";
import type { BackendConfig, BackendTool, PublicTool } from "./types.js";

/**
 * @notice JSON Schema used when a backend tool has no input schema.
 * @dev The MCP SDK rejects a tools/list entry whose inputSchema is missing
 *      or is not `type: object`. An empty object schema means "no arguments".
 */
const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
};

/**
 * @notice Keep a backend schema only when the SDK will accept it.
 * @param schema Value from tools/list.
 * @returns The same object when it is a JSON Schema object, otherwise the empty schema.
 */
function objectSchema(schema: unknown): Record<string, unknown> {
  if (
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    (schema as { type?: unknown }).type === "object"
  ) {
    return schema as Record<string, unknown>;
  }
  return EMPTY_OBJECT_SCHEMA;
}

/**
 * @notice Filter one backend's tools/list down to the configured allowlist.
 * @param backend Backend whose `allow` array is the permit list.
 * @param listed Tools the backend just returned. Order is not trusted.
 * @returns Public tools, sorted by public name so two refreshes compare equal.
 * @dev A configured name the backend did not return is logged and skipped.
 *      The process stays up: a typo should be visible, not fatal, because the
 *      other tools on that backend are still usable.
 */
export function publishTools(
  backend: BackendConfig,
  listed: BackendTool[],
): PublicTool[] {
  const permitted = new Set(backend.allow);
  const listedNames = new Set(listed.map((tool) => tool.name));
  const published: PublicTool[] = [];

  for (const name of backend.allow) {
    if (!listedNames.has(name)) {
      log({
        event: "allowlist_missing",
        backend: backend.id,
        tool: name,
      });
    }
  }

  for (const tool of listed) {
    if (!permitted.has(tool.name)) {
      continue;
    }
    const name = publicToolName(backend.id, tool.name);
    if (!isLegalPublicName(name)) {
      log({
        event: "tool_name_rejected",
        backend: backend.id,
        tool: tool.name,
        publicName: name,
      });
      continue;
    }
    published.push({
      backendId: backend.id,
      backendToolName: tool.name,
      publicName: name,
      description: tool.description,
      inputSchema: objectSchema(tool.inputSchema),
    });
  }

  published.sort((left, right) =>
    left.publicName.localeCompare(right.publicName),
  );
  return published;
}

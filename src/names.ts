/**
 * @title Public tool names
 * @notice Turns a backend id plus a backend tool name into the name clients see.
 * @dev The separator is two underscores because a single underscore already
 *      appears inside backend names (`list_sources` is not our style, but
 *      `search-drugs` could gain one later). Splitting on the first `__`
 *      recovers the backend id. MCP tool names may contain letters, digits,
 *      underscores, and hyphens, and must be at most 64 characters.
 */

/** @notice Pattern the MCP spec expects of a tool name clients will call. */
const PUBLIC_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * @notice Backend ids we accept in config. Short, so the prefix leaves room
 *         for the longest medical tool name inside the 64-character cap.
 */
export const BACKEND_ID = /^[a-z][a-z0-9-]{0,15}$/;

/**
 * @notice Name a client must send in tools/call.
 * @param backendId Config id, for example `medical`.
 * @param toolName Backend tool name, for example `list-sources`.
 * @returns `medical__list-sources`.
 */
export function publicToolName(backendId: string, toolName: string): string {
  return `${backendId}__${toolName}`;
}

/**
 * @notice Whether a public name is safe to put in tools/list.
 * @param name Candidate, including the prefix.
 * @returns True when the name matches the MCP tool-name pattern.
 * @dev A name that fails this is dropped, not rewritten. Rewriting would
 *      make the allowlist lie about which tool will be called.
 */
export function isLegalPublicName(name: string): boolean {
  return PUBLIC_NAME.test(name);
}

/**
 * @notice Split a client-supplied tool name into backend id and backend tool.
 * @param publicName Value from tools/call, for example `medical__list-sources`.
 * @returns The two parts, or null when the separator is missing or empty on one side.
 * @dev This does not check the allowlist. A well-formed name for a hidden tool
 *      still parses; the catalog then refuses it.
 */
export function parsePublicToolName(
  publicName: string,
): { backendId: string; toolName: string } | null {
  const separator = publicName.indexOf("__");
  if (separator <= 0 || separator >= publicName.length - 2) {
    return null;
  }
  return {
    backendId: publicName.slice(0, separator),
    toolName: publicName.slice(separator + 2),
  };
}

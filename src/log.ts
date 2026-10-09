/**
 * @title JSON logs
 * @notice One JSON object per line on stderr.
 * @dev Stderr matches medical-mcp, which keeps stdout free for stdio MCP.
 *      This process is HTTP-only, but the same stream means `kubectl logs`
 *      and `docker logs` show one shape. Tool arguments are never logged:
 *      a search query is not a secret, and it also does not belong in a log drain.
 */

/**
 * @notice Write one structured event.
 * @param event Fields to merge after the timestamp. Keep values short.
 * @dev `event` should be a stable string such as `tool_call` so a person
 *      can grep one kind of line. Do not pass request bodies.
 */
export function log(event: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    service: "omni-gateway",
    ...event,
  };
  console.error(JSON.stringify(line));
}

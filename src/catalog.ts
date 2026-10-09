/**
 * @title Tool catalog
 * @notice The allowlisted tools this process currently knows about.
 * @dev Refresh runs in the background. tools/list reads the last successful
 *      snapshot and does not wait on the backends, except for the refresh
 *      that startup awaits once before listen. A failed refresh keeps the
 *      previous tools for that backend so a restart of medical-mcp does not
 *      blank the public list for the whole interval.
 *
 *      The snapshot is per process. Replicas do not share it. That is safe
 *      because the snapshot is a cache of the backend, not session state.
 */

import { publishTools } from "./allowlist.js";
import type { BackendClient } from "./backend-client.js";
import { log } from "./log.js";
import type { BackendConfig, PublicTool } from "./types.js";

/**
 * @notice tools/list budget.
 * @dev Separate from the 45s tool-call budget. Listing tools is a local
 *      lookup on medical-mcp. If it takes longer than this, the backend is
 *      not healthy enough to refresh from.
 */
const LIST_TIMEOUT_MS = 10_000;

/**
 * @notice Where a public name should be forwarded.
 * @param backend Config entry, including the URL to POST to.
 * @param toolName Backend tool name with the prefix removed.
 */
export interface ResolvedTool {
  backend: BackendConfig;
  toolName: string;
}

/**
 * @notice In-memory catalog for one gateway process.
 */
export class ToolCatalog {
  private tools: PublicTool[] = [];
  private byName = new Map<string, ResolvedTool>();
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;

  /**
   * @param backends Configured backends, already environment-overridden.
   * @param refreshMs Delay between tools/list polls.
   * @param client HTTP client. Tests pass a fake.
   */
  constructor(
    private readonly backends: BackendConfig[],
    private readonly refreshMs: number,
    private readonly client: BackendClient,
  ) {}

  /**
   * @notice Start the refresh loop. Call `refresh` yourself first if the
   *         process should have tools before it listens.
   * @dev The timer is unref'd so it does not keep a test process alive.
   */
  start(): void {
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
    this.timer.unref();
  }

  /**
   * @notice Stop the refresh loop. In-flight refresh is allowed to finish.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * @notice Tools to put in the gateway's tools/list response.
   * @returns SDK-shaped tool objects. Hidden tools are absent.
   */
  list(): Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.tools.map((tool) => ({
      name: tool.publicName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * @notice Find the backend call for a public tool name.
   * @param publicName Client-supplied name, for example `medical__list-sources`.
   * @returns The route, or null when the name is unknown or not allowlisted.
   * @dev Null covers three cases the client should not be able to tell apart:
   *      bad prefix, tool the backend has but we hid, and tool nobody has.
   *      The error text is the same so hidden names are not confirmed.
   */
  resolve(publicName: string): ResolvedTool | null {
    return this.byName.get(publicName) ?? null;
  }

  /**
   * @notice Poll every backend and replace the snapshot.
   * @dev Overlapping refreshes are skipped. A slow backend must not pile up
   *      list calls. On failure, that backend's previous public tools stay.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const next: PublicTool[] = [];
      for (const backend of this.backends) {
        try {
          const listed = await this.client.listTools(
            backend.url,
            LIST_TIMEOUT_MS,
          );
          const published = publishTools(backend, listed);
          next.push(...published);
          log({
            event: "catalog_refresh",
            backend: backend.id,
            published: published.length,
          });
        } catch (error) {
          const kept = this.tools.filter(
            (tool) => tool.backendId === backend.id,
          );
          next.push(...kept);
          log({
            event: "catalog_refresh_failed",
            backend: backend.id,
            message: error instanceof Error ? error.message : "unknown",
            kept: kept.length,
          });
        }
      }
      next.sort((left, right) =>
        left.publicName.localeCompare(right.publicName),
      );
      this.tools = next;
      this.byName = indexTools(this.backends, next);
    } finally {
      this.refreshing = false;
    }
  }
}

/**
 * @notice Map public names to the backend that should receive the call.
 * @param backends Full config, so the URL is the live one.
 * @param tools Allowlisted tools from the latest refresh.
 * @returns Lookup used by resolve.
 * @dev A public name whose backend id disappeared from config is left out.
 *      That only happens if config changes without a process restart, which
 *      this version does not support.
 */
function indexTools(
  backends: BackendConfig[],
  tools: PublicTool[],
): Map<string, ResolvedTool> {
  const byId = new Map(backends.map((backend) => [backend.id, backend]));
  const index = new Map<string, ResolvedTool>();
  for (const tool of tools) {
    const backend = byId.get(tool.backendId);
    if (!backend) {
      continue;
    }
    index.set(tool.publicName, {
      backend,
      toolName: tool.backendToolName,
    });
  }
  return index;
}

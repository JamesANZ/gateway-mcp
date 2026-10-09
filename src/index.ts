/**
 * @title Process entry
 * @notice Loads config, fills the catalog once, and listens.
 * @dev Bind address and port come from HOST and PORT (the container and the
 *      Deployment set them). Which backends exist comes from GATEWAY_CONFIG.
 *      Those are split so a Pod can change the listen port without editing
 *      the allowlist, and can change the allowlist without changing the port.
 *
 *      This file is not imported by tests. Tests build a runtime and call
 *      startHttpServer so they do not install signal handlers.
 */

import { FetchBackendClient } from "./backend-client.js";
import { ToolCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { log } from "./log.js";

const configPath = process.env.GATEWAY_CONFIG ?? "config/gateway.yaml";
const config = loadConfig(configPath);
const client = new FetchBackendClient();
const catalog = new ToolCatalog(
  config.backends,
  config.catalogRefreshMs,
  client,
);

/**
 * @notice Log the route table without logging allowlisted arguments.
 * @dev The URL is not a secret. API keys are not in this config.
 */
log({
  event: "config_loaded",
  path: configPath,
  backends: config.backends.map((backend) => ({
    id: backend.id,
    url: backend.url,
    allow: backend.allow.length,
  })),
});

await catalog.refresh();
// @notice The first refresh often runs before medical-mcp is accepting.
//         Retry for about half a minute so the process that then listens
//         already has tools. /readyz also stays 503 while the list is empty,
//         so a Pod is not added to the Service during that wait.
for (
  let attempt = 1;
  attempt < 30 && catalog.list().length === 0;
  attempt += 1
) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await catalog.refresh();
}
catalog.start();

await startHttpServer({ config, catalog, client }, { handleSignals: true });

/**
 * @title Configuration loader
 * @notice Reads gateway.yaml, checks it, and applies MEDICAL_MCP_URL when set.
 * @dev Validation fails the process on startup. A running gateway with a
 *      half-parsed backend list would publish the wrong tools. Comments in
 *      the YAML file are discarded by the parser; they are for the reader.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { BACKEND_ID } from "./names.js";
import type { GatewayConfig } from "./types.js";

/**
 * @notice Shape of the YAML file before environment overrides.
 * @dev `url` must already be a URL so a Kubernetes deploy with no env var
 *      still has somewhere to send tools/call. `urlEnv` names the variable
 *      Compose uses to point at the Docker network hostname instead.
 */
const FileSchema = z.object({
  catalogRefreshMs: z.number().int().positive(),
  limits: z.object({
    requestTimeoutMs: z.number().int().positive(),
    maxInFlight: z.number().int().positive(),
    rateLimit: z.object({
      perMinute: z.number().int().positive(),
      burst: z.number().int().positive(),
    }),
  }),
  backends: z
    .array(
      z.object({
        id: z.string().regex(BACKEND_ID),
        url: z.string().url(),
        urlEnv: z.string().min(1).optional(),
        allow: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

/**
 * @notice Load a config file.
 * @param path Absolute or cwd-relative path. `GATEWAY_CONFIG` in the process env.
 * @param env Environment to read overrides from. Tests pass a plain object.
 * @returns Config the rest of the process can trust.
 * @dev Duplicate backend ids are rejected. Two entries named `medical` would
 *      make `medical__list-sources` ambiguous. Duplicate names inside one
 *      allow list are rejected for the same reason.
 */
export function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const raw = parse(readFileSync(path, "utf8"));
  const file = FileSchema.parse(raw);
  const seen = new Set<string>();

  const backends = file.backends.map((backend) => {
    if (seen.has(backend.id)) {
      throw new Error(`Duplicate backend id "${backend.id}" in ${path}`);
    }
    seen.add(backend.id);

    const allow = new Set<string>();
    for (const name of backend.allow) {
      if (allow.has(name)) {
        throw new Error(
          `Duplicate allow entry "${name}" on backend "${backend.id}"`,
        );
      }
      allow.add(name);
    }

    return {
      id: backend.id,
      url: overrideUrl(backend.url, backend.urlEnv, env),
      urlEnv: backend.urlEnv,
      allow: backend.allow,
    };
  });

  return {
    catalogRefreshMs: file.catalogRefreshMs,
    limits: {
      requestTimeoutMs: file.limits.requestTimeoutMs,
      maxInFlight: file.limits.maxInFlight,
      perMinute: file.limits.rateLimit.perMinute,
      burst: file.limits.rateLimit.burst,
    },
    backends,
  };
}

/**
 * @notice Replace a backend URL when its environment variable is non-empty.
 * @param url Value from the file. Used when the variable is unset.
 * @param urlEnv Variable name, or undefined when this backend has no override.
 * @param env Environment to read.
 * @returns The URL the client will POST to.
 * @dev An empty variable is treated as unset. Compose sometimes exports a
 *      blank string, and that must not wipe the cluster DNS name.
 */
function overrideUrl(
  url: string,
  urlEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (!urlEnv) {
    return url;
  }
  const value = env[urlEnv]?.trim();
  if (!value) {
    return url;
  }
  return z.string().url().parse(value);
}

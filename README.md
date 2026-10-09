# Omni MCP gateway

One Streamable HTTP endpoint that publishes an allowlist of tools from backend MCP servers. The first backend is medical-mcp. The gateway is the only process a client connects to. medical-mcp keeps its own Deployment and can still be called inside the cluster.

There is no login and no OAuth. Do not add a `401` or `403` response. Claude Code and VS Code treat those as an invitation to start OAuth.

## Read this in order

1. [config/gateway.yaml](config/gateway.yaml) — which tools are public, and the limits.
2. [src/http.ts](src/http.ts) — the POST `/mcp` endpoint, sessions, and why each request gets its own server object.
3. [src/forward.ts](src/forward.ts) — how `medical__list-sources` becomes a backend `list-sources` call.
4. [src/catalog.ts](src/catalog.ts) — the in-memory tool list, and what a second replica does not share.
5. [k8s/gateway.yaml](k8s/gateway.yaml) and [k8s/networkpolicy.yaml](k8s/networkpolicy.yaml) — what is reachable from outside the cluster.

## Clients this build is for

Cursor, Claude Code, and VS Code with GitHub Copilot speak Streamable HTTP and work against `http://127.0.0.1:8090/mcp`. Claude Desktop and ChatGPT open the connection from their own clouds, so they need the later public HTTPS URL. They are not part of this local build.

A Cursor project config is in [.cursor/mcp.json](.cursor/mcp.json). It does nothing until the gateway is listening.

## Docker

From this directory, with Docker running:

```bash
docker compose up --build
```

Medical MCP has no host port. The gateway container listens on 8080. Compose publishes that as `127.0.0.1:8090`, because 8080 on this machine is already used by another project.

```bash
node scripts/verify-gateway.mjs
```

That uses the official MCP client: tool discovery, a real `medical__list-sources` call, and a rejected `medical__health-check`. Add `--rate-limit` to spend the burst of 10 and expect `429`. Restart the gateway afterwards if you want Cursor to have a full burst:

```bash
docker compose restart gateway
```

Stop with `docker compose down`.

## Kubernetes

Docker Desktop's kubectl is newer than a kubectl that may already be on `PATH`. On this machine Kubernetes keeps its own containerd, separate from `docker build`, because the containerd image store is turned off. `scripts/load-k8s-images.sh` copies the two local images into that store. A cluster with the image store turned on can skip that script.

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
docker compose build
bash scripts/load-k8s-images.sh
kubectl apply -f ../medical-mcp/k8s/medical-mcp.yaml
kubectl apply -k .
kubectl rollout status deployment/medical-mcp
kubectl rollout status deployment/omni-gateway
kubectl port-forward svc/omni-gateway 8090:8080
```

Leave the port-forward running and, in another terminal, `node scripts/verify-gateway.mjs`. Stop the Compose gateway first if it is still bound to 8090.

To call medical-mcp without the gateway, forward its Service on another port. That is the independent-backend check. The NetworkPolicy does not block port-forward. Docker Desktop may not enforce the policy at all; the object is still applied so the hosted cluster has it.

Two replicas, then back to one:

```bash
bash scripts/verify-replicas.sh
```

The script scales both Deployments to 2, calls each gateway Pod, and scales both back to 1 on exit. One replica is the normal local and first-public size, because the rate limit and medical-mcp's upstream budget are per process.

## What is not running here

No Ingress, no certificate, no domain, and no load balancer. Those belong to the hosting step: a small DigitalOcean Kubernetes cluster in Sydney, one node and one load balancer, about $36 a month plus a domain. The Deployment and ClusterIP in this repo are the objects that step keeps.

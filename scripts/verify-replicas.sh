#!/usr/bin/env bash
# @title Two-replica check
# @notice Scale the gateway and medical-mcp to two Pods, call each gateway
#         Pod once, then scale both back to one.
# @dev port-forward to a Service sticks to one Pod, so this script forwards
#      each gateway Pod in turn. A successful call on each Pod is the proof
#      that no session has to follow the client. The Service still load-balances
#      when clients inside the cluster use http://omni-gateway:8080.
#
#      Run from the repo root after `kubectl apply` of both manifests.
#      Docker Desktop's kubectl is newer than the one often first on PATH.

set -euo pipefail

export PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH}"

if ! kubectl get deployment/omni-gateway >/dev/null 2>&1; then
  echo "deployment/omni-gateway is not in the current namespace" >&2
  exit 1
fi
if ! kubectl get deployment/medical-mcp >/dev/null 2>&1; then
  echo "deployment/medical-mcp is not in the current namespace" >&2
  exit 1
fi

scale_back() {
  kubectl scale deployment/omni-gateway --replicas=1
  kubectl scale deployment/medical-mcp --replicas=1
  kubectl rollout status deployment/omni-gateway --timeout=120s
  kubectl rollout status deployment/medical-mcp --timeout=120s
}
trap scale_back EXIT

kubectl scale deployment/medical-mcp --replicas=2
kubectl scale deployment/omni-gateway --replicas=2
kubectl rollout status deployment/medical-mcp --timeout=180s
kubectl rollout status deployment/omni-gateway --timeout=180s

pods=()
while IFS= read -r pod; do
  pods+=("$pod")
done < <(kubectl get pods -l app=omni-gateway -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')

if [[ "${#pods[@]}" -ne 2 ]]; then
  echo "expected 2 gateway pods, got ${#pods[@]}" >&2
  exit 1
fi

# @notice 18080 and 18081 avoid the host's 8080 (another project) and 8090
#         (the Compose gateway, if it is still running).
port=18080
for pod in "${pods[@]}"; do
  kubectl port-forward "pod/${pod}" "${port}:8080" >/tmp/omni-port-forward.log 2>&1 &
  forward_pid=$!
  # @notice Give the tunnel a moment. The verify script fails clearly if it is not up.
  sleep 1
  GATEWAY_URL="http://127.0.0.1:${port}/mcp" node scripts/verify-gateway.mjs
  kill "${forward_pid}" >/dev/null 2>&1 || true
  wait "${forward_pid}" >/dev/null 2>&1 || true
  port=$((port + 1))
done

echo "both gateway replicas answered"
# trap scales back to 1

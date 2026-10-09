#!/usr/bin/env bash
# @title Load local images into Docker Desktop Kubernetes
# @notice Copies medical-mcp:local and omni-gateway:local into the kubelet's
#         containerd. `docker compose build` is not enough on this machine.
# @dev Docker Desktop here has UseContainerdSnapshotter set to false. Images
#      from `docker build` live in the Docker engine. The cluster's kubelet
#      looks in a different containerd, does not find the tag, and tries
#      Docker Hub, which has no such repository. The result is ErrImagePull.
#
#      The loader Pod is privileged and uses the node's own `ctr` so the
#      import lands in the `k8s.io` namespace the kubelet reads. The Pod is
#      deleted at the end. It is not part of the running gateway.
#
#      Run this after `docker compose build`, and before `kubectl apply` if
#      the Pods are not up yet. If they are already stuck in ImagePullBackOff,
#      importing and then deleting the Pod is enough; the Deployment starts
#      another one, and imagePullPolicy IfNotPresent uses the imported tag.

set -euo pipefail

export PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH}"

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
cleanup() {
  rm -rf "${work}"
  kubectl delete pod omni-image-loader --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "saving images"
docker save medical-mcp:local -o "${work}/medical-mcp.tar"
docker save omni-gateway:local -o "${work}/omni-gateway.tar"

# @notice hostPath /tmp/omni-images is on the node, which is where `ctr` looks
#         after nsenter switches into the node's mount namespace. kubectl cp
#         into the mount is how the tar gets there without a registry.
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: omni-image-loader
  labels:
    app: omni-image-loader
spec:
  restartPolicy: Never
  hostPID: true
  containers:
    - name: loader
      image: busybox:1.36
      command: ["sleep", "600"]
      securityContext:
        privileged: true
      volumeMounts:
        - name: images
          mountPath: /images
  volumes:
    - name: images
      hostPath:
        path: /tmp/omni-images
        type: DirectoryOrCreate
EOF

kubectl wait --for=condition=Ready pod/omni-image-loader --timeout=180s
kubectl exec omni-image-loader -- sh -c 'rm -rf /images/*'
kubectl cp "${work}/medical-mcp.tar" omni-image-loader:/images/medical-mcp.tar
kubectl cp "${work}/omni-gateway.tar" omni-image-loader:/images/omni-gateway.tar

# @notice -t 1 is the node process. -m uses the node's mounts, so `ctr` is
#         the node's binary and the socket is the node's containerd.
kubectl exec omni-image-loader -- nsenter -t 1 -m -- ctr -n k8s.io images import /tmp/omni-images/medical-mcp.tar
kubectl exec omni-image-loader -- nsenter -t 1 -m -- ctr -n k8s.io images import /tmp/omni-images/omni-gateway.tar
kubectl exec omni-image-loader -- nsenter -t 1 -m -- ctr -n k8s.io images ls | grep -E 'medical-mcp|omni-gateway' || true

echo "images imported"

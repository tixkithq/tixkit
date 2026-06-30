#!/usr/bin/env bash
set -euo pipefail

kubectl get nodes -o wide
kubectl get runtimeclass
kubectl get pods -n arc-systems -o wide
kubectl get autoscalingrunnersets -n arc-runners -o wide
kubectl get autoscalinglisteners -n arc-systems -o wide
kubectl get networkpolicy -A

kubectl delete pod kata-smoke --ignore-not-found=true --wait=true
kubectl run kata-smoke \
  --image=busybox:1.36 \
  --restart=Never \
  --overrides='{"apiVersion":"v1","spec":{"runtimeClassName":"kata","nodeSelector":{"node-role.kubernetes.io/ci":"true"},"tolerations":[{"key":"dedicated","operator":"Equal","value":"ci","effect":"NoSchedule"}],"containers":[{"name":"kata-smoke","image":"busybox:1.36","command":["sh","-c","uname -a; grep -m1 \"model name\" /proc/cpuinfo"]}]}}'
kubectl wait --for=condition=Ready pod/kata-smoke --timeout=180s
kubectl logs kata-smoke
kubectl delete pod kata-smoke --wait=false

# Tixkit EPYC self-hosted Actions runner plan (ARC + Kata)

This repo is wired for a **split-trust** GitHub Actions setup:

- **Untrusted PRs** stay on GitHub-hosted runners.
- **Trusted pushes / manual runs** can use a self-hosted EPYC runner scale set.
- The recommended EPYC implementation is **Kubernetes + Actions Runner Controller + Kata runtimeClass**.

## Repo-side wiring already added

- `.github/workflows/ci.yml` now handles **PR + manual** GitHub-hosted CI.
- `.github/workflows/release-dry-run.yml` now handles **PR + manual** GitHub-hosted release dry runs.
- `.github/workflows/trusted-ci.yml` runs trusted Linux CI on self-hosted runners for **push + manual**.
- `.github/workflows/trusted-release-dry-run.yml` runs trusted release dry runs on self-hosted runners for **push to main + manual**.
- `infra/ci/arc/controller-values.yaml` contains ARC controller defaults.
- `infra/ci/arc/runner-values.yaml` contains the repo-scoped runner scale-set values.

## Runner labels expected by workflows

Trusted Linux jobs target:

```yaml
runs-on: [self-hosted, linux, tixkit, trusted]
```

The ARC scale set should therefore expose labels including:

- `tixkit`
- `trusted`
- `linux`
- `epyc`

## What this setup is trying to achieve

1. **Public/fork PR code never lands on the EPYC host.**
2. **Trusted jobs use ephemeral ARC runners.**
3. **Runner pods use `runtimeClassName: kata`** for microVM-backed isolation.
4. **Service-container-heavy jobs** (Postgres/MySQL/Redis/Temporal) are moved to the trusted runner lane.

## EPYC host-side state

The EPYC host has been configured with:

- Ubuntu 24.04
- k3s `v1.36.2+k3s1`
- Kata Containers `3.32.0`
- k3s containerd runtime handler named `kata`
- Kubernetes `RuntimeClass` named `kata`
- ARC controller chart `0.14.2`
- ARC runner scale set chart `0.14.2`
- repo-scoped runner scale set `tixkit-epyc-trusted`
- ARC namespace Pod Security labels and NetworkPolicy manifests in `infra/ci/k8s/arc-hardening.yaml`

The runner scale set is configured with `minRunners: 0` and `maxRunners: 8`, so idle runner pods are not kept around. ARC keeps a listener pod online and creates ephemeral Kata-backed runner pods when trusted jobs are assigned.

## Rebuild host-side install sequence

### 1) Install Kubernetes

Recommended: **k3s** on the EPYC host.

Example:

```bash
curl -sfL https://get.k3s.io | sh -
sudo kubectl get nodes
```

Label and taint the node so only CI lands there:

```bash
sudo kubectl label node <node-name> node-role.kubernetes.io/ci=true --overwrite
sudo kubectl taint node <node-name> dedicated=ci:NoSchedule --overwrite
```

### 2) Install Kata Containers on the node

Kata’s Kubernetes/containerd docs require:

- containerd configured with a Kata runtime handler
- a Kubernetes `RuntimeClass` named `kata`

RuntimeClass example:

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata
handler: kata
```

Apply it:

```bash
sudo kubectl apply -f runtimeclass-kata.yaml
```

### 3) Install Helm

```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
```

### 4) Install ARC controller

```bash
helm install arc \
  --namespace arc-systems \
  --create-namespace \
  -f infra/ci/arc/controller-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller
```

### 5) Apply ARC namespace hardening

```bash
kubectl apply -f infra/ci/k8s/arc-hardening.yaml
```

The manifest adds:

- Pod Security Admission labels for `arc-systems` and `arc-runners`
- default-deny ingress for ARC namespaces
- egress allow rules for DNS, Kubernetes API, and HTTP/HTTPS job traffic

`arc-runners` enforces `privileged` because Docker-in-Docker requires a privileged dind container. It still uses `restricted` audit/warn labels so future runner-mode hardening is visible.

On k3s' default flannel CNI, Kubernetes `NetworkPolicy` resources are accepted but not enforced. Use a NetworkPolicy-capable CNI such as Cilium or Calico before relying on these policies as a boundary.

### 6) Create GitHub auth secret

```bash
kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic arc-github-auth \
  -n arc-runners \
  --from-literal=github_app_id='<app_id>' \
  --from-literal=github_app_installation_id='<installation_id>' \
  --from-file=github_app_private_key=/path/to/private-key.pem
```

### 7) Install the repo-scoped runner scale set

```bash
helm install tixkit-epyc-trusted \
  --namespace arc-runners \
  --create-namespace \
  -f infra/ci/arc/runner-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

## Verification commands

Check ARC controller:

```bash
kubectl get pods -n arc-systems
```

Check runner scale set:

```bash
kubectl get autoscalingrunnersets -n arc-runners
kubectl get pods -n arc-runners
```

Check the repo sees the runner registration:

```bash
gh api repos/nkgotcode/tixkit/actions/runners
```

Trigger a trusted workflow manually:

```bash
gh workflow run trusted-ci.yml --repo nkgotcode/tixkit
```

Watch runs:

```bash
gh run list --repo nkgotcode/tixkit --workflow trusted-ci.yml
```

## Important caveats

### 1) Kata verification
The cluster must keep a functioning `kata` runtime class. If `runtimeClassName: kata` fails, ARC runner pods will stay pending or fail admission.

### 2) DIND is intentionally retained
The ARC runner values use `containerMode.type: dind` because existing Tixkit workflows depend on GitHub Actions service containers. That preserves compatibility with the current CI jobs.

### 3) iOS stays GitHub-hosted
`trusted-ci.yml` keeps the iOS job on `macos-latest`; the EPYC Linux runner cannot replace that lane.

### 4) GitHub App auth
Use GitHub App authentication so runner registration is not tied to a human account token. The app should be installed only on `nkgotcode/tixkit`.

For repo-scoped ARC registration, GitHub's ARC docs require:

- Repository permissions:
  - Administration: read and write
  - Metadata: read-only
- Organization permissions:
  - Self-hosted runners: read and write

Then replace the live `arc-github-auth` secret with:

```bash
sudo env \
  KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
  GITHUB_APP_ID='<app_id>' \
  GITHUB_APP_INSTALLATION_ID='<installation_id>' \
  GITHUB_APP_PRIVATE_KEY_FILE='/path/to/app-private-key.pem' \
  /home/itsnk/tixkit/infra/ci/scripts/create-arc-github-app-secret.sh

sudo kubectl rollout restart deploy/arc-gha-rs-controller -n arc-systems
sudo kubectl rollout status deploy/arc-gha-rs-controller -n arc-systems --timeout=180s
sudo kubectl get autoscalingrunnersets -n arc-runners -o wide
```

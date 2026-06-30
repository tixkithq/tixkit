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
- `infra/ci/arc/runner-image/Dockerfile` builds the custom ARC runner image with Flutter/Linux prerequisites preinstalled.

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
- `self-hosted`

## What this setup is trying to achieve

1. **Public/fork PR code never lands on the EPYC host.**
2. **Trusted jobs use ephemeral ARC runners.**
3. **Runner pods use `runtimeClassName: kata`** for microVM-backed isolation.
4. **Service-container-heavy jobs** (Postgres/MySQL/Redis/Temporal) are moved to the trusted runner lane. MSSQL runs as a dedicated Kubernetes service because the upstream SQL Server image cannot be unpacked by Docker inside Kata.

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
- local Docker registry on `localhost:5000`
- ARC namespace Pod Security labels and NetworkPolicy manifests in `infra/ci/k8s/arc-hardening.yaml`

The runner scale set is configured with `minRunners: 0` and `maxRunners: 12`, so idle runner pods are not kept around. ARC keeps a listener pod online and creates ephemeral Kata-backed runner pods when trusted jobs are assigned. The custom runner image and Docker-in-Docker image are pinned with explicit versions and SHA-256 digests in `infra/ci/arc/runner-values.yaml`; update them through review instead of floating tags. Runner containers request 4 CPU / 8 GiB and can burst up to 16 CPU / 24 GiB. The MSSQL Kubernetes deployment separately requests 2 CPU / 8 GiB and is capped at 8 CPU / 12 GiB.

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

### 4) Configure the EPYC local registry

The custom runner image is built with host Docker and served from a local registry because Docker builds inside Kata-backed ARC pods cannot register some upstream runner image layer xattrs.

```bash
sudo mkdir -p /opt/tixkit-registry
docker run -d --restart=always \
  --name tixkit-registry \
  -p 5000:5000 \
  -v /opt/tixkit-registry:/var/lib/registry \
  registry:2

sudo tee /etc/rancher/k3s/registries.yaml >/dev/null <<'EOF'
mirrors:
  "localhost:5000":
    endpoint:
      - "http://localhost:5000"
  "100.103.201.10:5000":
    endpoint:
      - "http://100.103.201.10:5000"
EOF

sudo systemctl restart k3s
sudo kubectl wait --for=condition=Ready node --all --timeout=180s
```

Build and publish the runner image:

```bash
docker build --platform linux/amd64 \
  -t localhost:5000/tixkit-arc-runner:2.335.1-flutter \
  infra/ci/arc/runner-image
docker push localhost:5000/tixkit-arc-runner:2.335.1-flutter
docker inspect --format '{{index .RepoDigests 0}}' localhost:5000/tixkit-arc-runner:2.335.1-flutter
```

Pin the resulting digest in `infra/ci/arc/runner-values.yaml`.

### 5) Start MSSQL for trusted CI

Postgres/MySQL/Redis/Temporal run as normal GitHub Actions service containers through the ARC dind sidecar. MSSQL is different: the upstream SQL Server image contains `security.capability` xattrs on `sqlservr`, and Docker inside Kata cannot register that layer. Run MSSQL as a Kubernetes deployment in `arc-runners` and point trusted CI at its cluster DNS name.

SQL Server also needs a larger host async I/O limit on this node:

```bash
echo "fs.aio-max-nr = 1048576" | sudo tee /etc/sysctl.d/99-tixkit-ci-mssql.conf
sudo sysctl --system
```

```bash
kubectl apply -f infra/ci/k8s/trusted-ci-mssql.yaml
kubectl rollout status deployment/tixkit-ci-mssql -n arc-runners --timeout=300s
```

The manifest adds narrow NetworkPolicies so ARC runner pods can reach only TCP 1433 on the MSSQL pod while the namespace-wide ingress and egress defaults stay locked down.

```bash
kubectl exec -n arc-runners deploy/tixkit-ci-mssql -- \
  /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P Test-password-12345 -C \
  -Q "IF DB_ID('tixkit') IS NULL CREATE DATABASE tixkit"
```

The trusted workflow uses `sqlserver://sa:Test-password-12345@tixkit-ci-mssql.arc-runners.svc.cluster.local:1433/tixkit?encrypt=false&trustServerCertificate=true`.

### 6) Install ARC controller

```bash
helm install arc \
  --namespace arc-systems \
  --create-namespace \
  -f infra/ci/arc/controller-values.yaml \
  --version 0.14.2 \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller
```

### 7) Apply ARC namespace hardening

```bash
kubectl apply -f infra/ci/k8s/arc-hardening.yaml
```

The manifest adds:

- Pod Security Admission labels for `arc-systems` and `arc-runners`
- default-deny ingress for ARC namespaces
- egress allow rules for DNS, Kubernetes API, and HTTP/HTTPS job traffic

`arc-runners` enforces `privileged` because Docker-in-Docker requires a privileged dind container. It still uses `restricted` audit/warn labels so future runner-mode hardening is visible.

On k3s' default flannel CNI, Kubernetes `NetworkPolicy` resources are accepted but not enforced. Use a NetworkPolicy-capable CNI such as Cilium or Calico before relying on these policies as a boundary.

### 8) Create GitHub auth secret

```bash
kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic arc-github-auth \
  -n arc-runners \
  --from-literal=github_app_id='<app_id>' \
  --from-literal=github_app_installation_id='<installation_id>' \
  --from-file=github_app_private_key=/path/to/private-key.pem
```

### 9) Install the repo-scoped runner scale set

```bash
helm install tixkit-epyc-trusted \
  --namespace arc-runners \
  --create-namespace \
  -f infra/ci/arc/runner-values.yaml \
  --version 0.14.2 \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

## Verification commands

Check that the committed ARC chart and image references are pinned before applying them:

```bash
bun run verify:arc:kata:supply-chain
```

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

The ARC runner values keep Docker-in-Docker enabled because existing Tixkit workflows depend on GitHub Actions service containers. That preserves compatibility with the current CI jobs.

The values file spells out the dind pod template instead of using ARC's generated `containerMode.type: dind` template so the Docker daemon can run with `--storage-driver=vfs`. Kata-backed pods reject overlayfs mounts when GitHub service containers are created, so leaving Docker on its default overlay driver makes trusted jobs fail before repo steps run.

The custom runner image preinstalls `xz-utils`, `unzip`, `clang`, `cmake`, `ninja-build`, and GTK/OpenGL packages so Flutter SDK setup and Linux/web builds do not need privileged package installation during CI.

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

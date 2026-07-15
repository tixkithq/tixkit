# Production cluster rehearsal

`bun run iac:prove:production` runs one explicitly authorized Production failure or release drill and publishes Ed25519-signed, SHA-256-checksummed evidence. It is designed for a dedicated production-like cluster. It does not provision a cluster and it does not turn a local adapter test into production evidence.

The configuration must validate against `rehearsal-config.schema.json`. Supported drill kinds and exact acknowledgements are:

| Kind                       | Exact acknowledgement                                                 | Required behavior                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `zone-loss`                | `I authorize production zone-loss fault injection and recovery`       | `inject` removes one reviewed failure domain; the during probe remains healthy; `recover` restores it.                                      |
| `dependency-loss`          | `I authorize production dependency-loss fault injection and recovery` | `dependency` names the lost service; the during probe exits `1` and reports unhealthy; recovery returns the full golden journey to healthy. |
| `release-upgrade-rollback` | `I authorize production release upgrade and application rollback`     | `inject` installs the target immutable public release; the during probe is healthy; `recover` reinstalls the reviewed prior release.        |

Every adapter is a no-argument, operator-owned executable. Before any adapter runs, the harness reads each source through a non-following file descriptor and copies the reviewed bytes into a private mode-`0500` staging directory. It executes only those staged inodes, checks their SHA-256 before and after use, imposes the configured timeout and a 4 MiB combined output ceiling, and never writes adapter output into evidence. Adapter commands run in isolated process groups; timeout kills the group, and `SIGINT`/`SIGTERM` after injection cancels active work and runs bounded recovery before the harness exits. Standard error may contain diagnostics. Standard output must contain exactly one object:

```json
{
  "schemaVersion": "tixkit-production-adapter-result-v1",
  "healthy": true,
  "outageMilliseconds": 0,
  "observationCount": 12
}
```

The probe adapter must execute a real authenticated golden journey, not only a Kubernetes readiness check. Measure continuously across the operation and report observed unavailability in `outageMilliseconds`; do not infer zero from a successful final request. The dependency-loss during probe is the only adapter that reports `healthy: false` and exits `1`. All other adapters report healthy and exit `0`.

The harness independently binds the HTTPS cluster server, decoded CA hash, kube-system UID, target namespace UID, Helm revision/chart/app version/manifest/values hashes, immutable workload image references, Ready pod and node UIDs, and observed zones. It requires every workload to remain Ready across at least two zones before accepting a snapshot. The prior and target files must be valid public release manifests.

Keep the Ed25519 private key in an operator-controlled mode-`0600` file. Use an existing non-symlink evidence directory. The harness exclusively reserves `<drillId>.json`, `.json.sig`, and `.json.sha256` at mode `0400`; a failed run leaves non-valid reserved files and requires a new drill ID.

Run one configuration at a time:

```bash
bun run iac:prove:production -- \
  --config /srv/tixkit-production-proof/zone-loss.json \
  --evidence-dir /srv/tixkit-production-proof/evidence \
  --private-key /srv/tixkit-production-proof/reviewer-ed25519.pem
```

Verification is fail-closed against independently reviewed expectations, so a valid old or substituted proof cannot satisfy a new drill:

```bash
bun run iac:verify:production-proof -- \
  --evidence /srv/tixkit-production-proof/evidence/zone-loss-20260714.json \
  --signature /srv/tixkit-production-proof/evidence/zone-loss-20260714.json.sig \
  --checksum /srv/tixkit-production-proof/evidence/zone-loss-20260714.json.sha256 \
  --public-key /srv/tixkit-production-proof/reviewer-ed25519.pub \
  --expectations /srv/tixkit-production-proof/zone-loss-expectations.json
```

The expectations file validates against `rehearsal-expectations.schema.json`. Review it before the drill; it binds the exact drill/dependency, cluster server and decoded CA hash, namespace identities, release name, prior/target release manifest hashes, outage/recovery thresholds, and all five adapter hashes. The standalone verifier additionally enforces the exact per-kind step results and snapshot sequence, so a signed proof for a different dependency or weaker threshold is rejected. Retain the proof, signature, checksum, public key, reviewed configuration and expectations, adapter hashes, release manifests, alert/trace artifacts, and external provider DR receipts together. Run separate dependency drills for the configured relational database, Redis, Temporal and object storage. Provider restore, cross-store reconciliation and RPO/RTO evidence still come from the Production DR scripts and must be evaluated alongside these cluster artifacts.

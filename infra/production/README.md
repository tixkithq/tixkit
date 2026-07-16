# Production cluster rehearsal

`bun run iac:prove:production` runs one explicitly authorized Production failure or release drill and publishes Ed25519-signed, SHA-256-checksummed evidence. It is designed for a dedicated production-like cluster. It does not provision a cluster and it does not turn a local adapter test into production evidence.

The configuration must validate against `rehearsal-config.schema.json`. Supported drill kinds and exact acknowledgements are:

| Kind                       | Exact acknowledgement                                                 | Required behavior                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `zone-loss`                | `I authorize production zone-loss fault injection and recovery`       | `inject` removes one reviewed failure domain; the during probe remains healthy; `recover` restores it.                                      |
| `dependency-loss`          | `I authorize production dependency-loss fault injection and recovery` | `dependency` names the lost service; the during probe exits `1` and reports unhealthy; recovery returns the full golden journey to healthy. |
| `release-upgrade-rollback` | `I authorize production release upgrade and application rollback`     | `inject` installs the target immutable public release; the during probe is healthy; `recover` reinstalls the reviewed prior release.        |

Every adapter is a no-argument, operator-owned executable. Before any adapter runs, the harness requires an independently prepared expectations file, reads it through a bounded non-following descriptor, validates its schema, and requires current-user ownership with no group/world access. It then resolves the live cluster identity, public release manifests, thresholds, and all five adapter hashes and compares that complete input set exactly with the reviewed expectations. A mismatch executes zero adapters. Only then does the harness copy the reviewed adapter bytes into a private mode-`0500` staging directory. It executes only those staged inodes, checks their SHA-256 before and after use, imposes the configured timeout and a 4 MiB combined output ceiling, and never writes adapter output into evidence. Adapter commands run in isolated process groups; timeout kills the group, and `SIGINT`/`SIGTERM` after injection cancels active work and runs bounded recovery before the harness exits. Standard error may contain diagnostics. Standard output must contain exactly one object:

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

Keep the Ed25519 private key in an operator-controlled mode-`0600` file. Use an existing, current-user-owned, non-symlink evidence directory with mode `0700` or stricter. The harness pins its canonical device and inode through adapter staging, artifact reservation, fsync, and publication. It exclusively reserves `<drillId>.json`, `.json.sig`, and `.json.sha256` at mode `0400`, then rechecks each descriptor and pathname device, inode, owner, mode, and link count before and throughout publication. A failed run after reservation leaves non-valid reserved files and requires a new drill ID.

Run one configuration at a time:

```bash
bun run iac:prove:production -- \
  --config /srv/tixkit-production-proof/zone-loss.json \
  --evidence-dir /srv/tixkit-production-proof/evidence \
  --private-key /srv/tixkit-production-proof/reviewer-ed25519.pem \
  --expectations /srv/tixkit-production-proof/zone-loss-expectations.json
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

The expectations file validates against `rehearsal-expectations.schema.json`. Create it independently, set mode `0600` or stricter, and review it before the drill; it binds the exact drill/dependency, cluster server and decoded CA hash, namespace identities, release name, prior/target release manifest hashes and image maps, outage/recovery thresholds, and all five adapter hashes. The proof command enforces it before adapter execution, while the standalone verifier enforces it again alongside the exact per-kind step results and snapshot sequence. A signed proof for a different dependency, image, adapter, cluster, or weaker threshold is rejected. Retain the proof, signature, checksum, public key, reviewed configuration and expectations, adapter hashes, release manifests, alert/trace artifacts, and external provider DR receipts together. Run separate dependency drills for the configured relational database, Redis, Temporal and object storage. Provider restore, cross-store reconciliation and RPO/RTO evidence still come from the Production DR scripts and must be evaluated alongside these cluster artifacts.

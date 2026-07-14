# Public distribution contract

`public-distribution.json` is the machine-readable source of truth for the authoritative public Tixkit repository boundary. Transitional OSS export, SDK parity, package/image release inventory, contract publication, and Self-Hosted profile validation consume this manifest.

The manifest distinguishes:

- public shared product and Self-Hosted source;
- private Cloud-only source under `managed/` during extraction;
- internal planning documents that are not public product documentation;
- generated public release artifacts that must be reproduced by their generators rather than edited manually.

The intended public license is MIT, but the manifest deliberately records `pending-legal-review` and forbids claiming legal approval. While that state is pending, npm package metadata remains `UNLICENSED` and workflows may only build or dry-run packs; publication is not authorized. Approval requires the canonical `docs/completion/legal-review-approval.md` evidence artifact, after which package metadata must be changed to MIT before validation permits release. This repository does not currently contain that approval artifact.

Run:

```bash
bun run validate:public-distribution
bun run export:oss -- --out /tmp/tixkit-public
```

Adding an app, package, SDK, image, contract, or deployment profile without classifying it fails validation. Public applications and packages may not depend on `managed`, `tixkit-cloud`, or private package names. Until C-130 cutover is proven, `scripts/export-oss.mjs` remains an extraction and leak-validation bridge; direct releases from `tixkit/tixkit` replace it after cutover.

`scripts/rehearse-repository-cutover.mjs` is a transitional local extraction control and is never included in the public output. It binds both staged repositories to a clean source commit, requires explicit review of ignored private inputs, rejects cross-boundary source copying and writes a local-only inventory attestation. It cannot substitute for legal approval, hosted history review, protected repository evidence, immutable prerelease publication or a real private Cloud compatibility pin.

The C-130 cutover rehearsals commit the rewritten public tree first, then rebind the active API release manifest and its documentation mirror to that exact public-root commit. Rebinding is accepted only for a clean clone whose `origin` is `tixkit/tixkit`, changes only the paired release manifests and checksums, and produces a second reviewed commit. Transitional exports may use recorded-source/derived-export validation only as non-publishable integrity evidence; `validate:public-repository -- --repository .` requires strict reconstructable, publishable provenance and must never use those transition flags.

Private Cloud releases consume `cloud-core-compatibility.schema.json` without copying it into private history. The protected `public-artifact-release.yml` tag workflow emits a provenance-attested manifest conforming to `public-release-manifest.schema.json`; it contains the exact source commit/tree, npm tarball integrity, a canonical digest of every packaged path, byte sequence and executable mode, registry image digests and published contracts. It is fail-closed while legal approval is pending or while private/internal source remains in the checkout. The workflow publishes those same tarballs, uses unique candidate image tags while contracts consume digests, and supports safe retries only when an existing npm version has identical bytes.

The compatibility `core` object remains byte-identical to the complete verified public release inventory. `cloudRelease.consumedPackages` separately declares the exact public package subset installed by that private release; every declared package must resolve with the public integrity/content tuple, every installed public transitive dependency must be declared, and unrelated SDK or browser packages are not injected into private services merely to satisfy release inventory checks.

Cloud CI runs `bun run validate:cloud-core-consumer -- --manifest <private-manifest> --public-release-manifest <verified-public-manifest> --cloud-root <private-repository>` from pinned public tooling. The command verifies GitHub provenance itself and binds the attestation to `tixkit/tixkit/.github/workflows/public-artifact-release.yml`, the version tag, the source commit and a GitHub-hosted runner. Passing an unverified, differently signed or locally invented public manifest is not release proof.

The private compatibility manifest must exactly match that verified public release record. Validation also checks the frozen Bun lockfile, an isolated Bun install using the `copyfile` backend, exact direct and peer dependencies (including the unscoped CLI), npm-alias bypasses, package completeness, renamed source copies and private patches. Release semantics are validated from the attested inventory, so current, next and oldest-supported releases do not depend on package or migration versions in the validator's checkout. The compatibility manifest itself stays private because it identifies a concrete Cloud release and its deployed artifact set. Until public package and image release automation emits and attests the first real manifest, this validator is a locally proven contract rather than evidence of a deployed Cloud/core pairing.

Cloud build and test commands run through `bun run verify:cloud-core-install -- --manifest <private-manifest> --public-release-manifest <attested-public-manifest> --cloud-root <private-repository> --writable-path <common-output-root> -- bun run build`. The wrapper authenticates and parses the same manifest bytes, rejects unbound private inputs, verifies the declared digest of every installed dependency and executable shim, and materializes the exact private commit plus that complete installation. It reverifies both the full installation and each public package after copying, then executes from the immutable view with only the minimal operating-system runtime visible. Linux runners require `/usr/bin/bwrap`; Git and archive operations also use fixed system executables. macOS uses the system sandbox. At most one absent output root may be declared; it cannot overlap source or dependencies. The wrapper pins that staged directory's inode, computes its content digest as the trust-transfer record, and atomically moves the same inode through candidate verification to the final destination. Private CI must preserve the wrapper log with compatibility evidence. Package lifecycle hooks and build scripts that delegate to mutable local patch helpers are rejected earlier.

The verifier is an artifact-boundary control, not an operating-system privilege boundary. A Cloud release job must run in a dedicated, fresh workspace under an isolated OS principal with no concurrent process using that principal, and the verified command must not daemonize or leave descendants running when it exits. A process with the verifier's own OS identity can mutate an output after successful return and therefore cannot be treated as an untrusted actor that this wrapper alone contains. Job-level process cleanup and workspace disposal are required before the principal is reused.

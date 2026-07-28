# Public distribution contract

`public-distribution.json` is the machine-readable source of truth for the authoritative public Tixkit repository boundary. SDK parity, package/image release inventory, contract publication, and Self-Hosted profile validation consume this manifest.

The manifest distinguishes:

- public shared product and Self-Hosted source;
- forbidden private Cloud dependencies and source paths;
- private planning documents that must not enter the public repository;
- generated public release artifacts that must be reproduced by their generators rather than edited manually.

The public license is MIT. The repository owner authorization and technical provenance/license audit are preserved in the root `LEGAL_APPROVAL.md` receipt. Public release validation binds the canonical root license and approval receipt, requires every public package and SDK license surface to use MIT, and rejects private or unclassified content.

Run:

```bash
bun run validate:public-distribution
bun run validate:public-repository -- --repository .
```

Adding an app, package, SDK, image, contract, or deployment profile without classifying it fails validation. Public applications and packages may not depend on `managed`, `tixkit-cloud`, or private package names. Releases originate directly from this repository.

The repository rehearsal requires a clean clone whose `origin` is `tixkithq/tixkit`, strict reconstructable publishable provenance, a complete build and test sequence, and an unchanged tracked tree after generation.

Private Cloud releases consume `cloud-core-compatibility.schema.json` without copying it into private history. The protected `public-artifact-release.yml` tag workflow emits a provenance-attested manifest conforming to `public-release-manifest.schema.json`; it contains the exact source commit/tree, npm tarball integrity, a canonical digest of every packaged path, byte sequence and executable mode, registry image digests and published contracts. It is fail-closed while legal approval is pending or while private/internal source remains in the checkout. The workflow publishes those same tarballs, uses unique candidate image tags while contracts consume digests, and supports safe retries only when an existing npm version has identical bytes.

The compatibility `core` object remains byte-identical to the complete verified public release inventory. `cloudRelease.consumedPackages` separately declares the exact public package subset installed by that private release; every declared package must resolve with the public integrity/content tuple, every installed public transitive dependency must be declared, and unrelated SDK or browser packages are not injected into private services merely to satisfy release inventory checks.

After an isolated frozen install, private Cloud CI runs `bun run build:cloud-core-compatibility -- --public-release-manifest <attested-public-manifest> --cloud-root <private-repository> --cloud-version <private-release> --out <new-private-manifest>`. The builder derives the clean private commit and consumed package set instead of accepting them as inputs, binds every installation tree, validates the result against the attested release, and publishes a new mode-0600 manifest without replacing an existing record.

Cloud CI runs `bun run validate:cloud-core-consumer -- --manifest <private-manifest> --public-release-manifest <verified-public-manifest> --cloud-root <private-repository>` from pinned public tooling. The command verifies GitHub provenance itself and binds the attestation to `tixkithq/tixkit/.github/workflows/public-artifact-release.yml`, the version tag, the source commit and a GitHub-hosted runner. Passing an unverified, differently signed or locally invented public manifest is not release proof.

The private compatibility manifest must exactly match that verified public release record. Validation also checks the frozen Bun lockfile, an isolated Bun install using the `copyfile` backend, exact direct and peer dependencies (including the unscoped CLI), npm-alias bypasses, package completeness, renamed source copies and private patches. Release semantics are validated from the attested inventory, so current, next and oldest-supported releases do not depend on package or migration versions in the validator's checkout. The compatibility manifest itself stays private because it identifies a concrete Cloud release and its deployed artifact set. Until public package and image release automation emits and attests the first real manifest, this validator is a locally proven contract rather than evidence of a deployed Cloud/core pairing.

Cloud build and test commands run through `bun run verify:cloud-core-install -- --manifest <private-manifest> --public-release-manifest <attested-public-manifest> --cloud-root <private-repository> --writable-path <common-output-root> -- bun run build`. The wrapper authenticates and parses the same manifest bytes, rejects unbound private inputs, verifies the declared digest of every installed dependency and executable shim, and materializes the exact private commit plus that complete installation. It reverifies both the full installation and each public package after copying, then executes from the immutable view with only the minimal operating-system runtime visible. Linux runners require `/usr/bin/bwrap`; Git and archive operations also use fixed system executables. macOS uses the system sandbox. At most one absent output root may be declared; it cannot overlap source or dependencies. The wrapper pins that staged directory's inode, computes its content digest as the trust-transfer record, and atomically moves the same inode through candidate verification to the final destination. Private CI must preserve the wrapper log with compatibility evidence. Package lifecycle hooks and build scripts that delegate to mutable local patch helpers are rejected earlier.

The verifier is an artifact-boundary control, not an operating-system privilege boundary. A Cloud release job must run in a dedicated, fresh workspace under an isolated OS principal with no concurrent process using that principal, and the verified command must not daemonize or leave descendants running when it exits. A process with the verifier's own OS identity can mutate an output after successful return and therefore cannot be treated as an untrusted actor that this wrapper alone contains. Job-level process cleanup and workspace disposal are required before the principal is reused.

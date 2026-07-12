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

Private Cloud releases consume `cloud-core-compatibility.schema.json` without copying it into private history. The protected `public-artifact-release.yml` tag workflow emits a provenance-attested manifest conforming to `public-release-manifest.schema.json`; it contains the exact source commit/tree, integrity of npm tarballs packed from a fresh Git archive, registry image digests and published contracts. It is fail-closed while legal approval is pending or while private/internal source remains in the checkout. The workflow publishes those same tarballs, uses unique candidate image tags while contracts consume digests, and supports safe retries only when an existing npm version has identical bytes.

Cloud CI runs `bun run validate:cloud-core-consumer -- --manifest <private-manifest> --public-release-manifest <verified-public-manifest> --cloud-root <private-repository>` from pinned public tooling. The command verifies GitHub provenance itself and binds the attestation to `tixkit/tixkit/.github/workflows/public-artifact-release.yml`, the version tag, the source commit and a GitHub-hosted runner. Passing an unverified, differently signed or locally invented public manifest is not release proof.

The private compatibility manifest must exactly match that verified public release record. Validation also checks the frozen Bun lockfile, exact direct and peer dependencies (including the unscoped CLI), npm-alias bypasses, package completeness, renamed source copies, private patches and protocol claims that have no released public contract. The compatibility manifest itself stays private because it identifies a concrete Cloud release and its deployed artifact set. Until public package and image release automation emits and attests the first real manifest, this validator is a locally proven contract rather than evidence of a deployed Cloud/core pairing.

Cloud build and test commands run through `bun run verify:cloud-core-install -- --manifest <private-manifest> --cloud-root <private-repository> -- bun run build`. The wrapper snapshots every installed public package before execution and fails if any byte changes; private CI must preserve that log with the compatibility evidence. Package lifecycle hooks and build scripts that delegate to mutable local patch helpers are rejected earlier.

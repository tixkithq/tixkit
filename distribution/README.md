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

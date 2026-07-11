## Outcome

Describe the user-visible or operational result and the primary persona it serves.

## Scope

- Affected apps/packages:
- Public contracts changed (API/OpenAPI/SDK/CLI/config/routes):
- Tenant, organization, brand, permission, or secret-handling impact:
- Backward-compatibility or migration impact:

## Documentation and generated artifacts

- Canonical guides/READMEs updated:
- Generated files updated and drift check run:
- Public/internal and OSS-export boundary checked:

## Validation performed

List exact commands and outcomes. Do not describe a skipped suite as passing.

```text
command — PASS/FAIL/SKIPPED (reason)
```

## Review checklist

- [ ] The change is focused and contains no unrelated formatting or generated local state.
- [ ] Types, runtime contracts, tests, examples, and documentation were updated together.
- [ ] Tenant/permission isolation and server-only secret handling were considered and tested where applicable.
- [ ] User-facing behavior is keyboard, screen-reader, responsive, and reduced-motion safe where applicable.
- [ ] No credentials, customer data, private payloads, or sensitive logs appear in code, fixtures, docs, screenshots, or generated output.
- [ ] Focused validation passed; infrastructure-dependent or skipped validation is identified above.
- [ ] `git diff --check` passes.

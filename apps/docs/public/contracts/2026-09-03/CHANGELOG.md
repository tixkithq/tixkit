# API 2026-09-03

Compared with 2026-09-02. Breaking changes: 22. Compatible changes: 7.

- OpenAPI JSON and YAML
- Generated TypeScript declarations
- Webhook event catalog
- Sanitized request/response examples
- Machine-readable API diff and checksums

## Breaking changes

- `POST /events/{eventId}/ticket-types/batch.requestBody.content.application/json.schema.properties.accessRules.items.properties.value`: maxLength became more restrictive.
- `POST /events/{eventId}/ticket-types/batch.requestBody.content.application/json.schema.properties.accessRules.items.properties.maxUses`: maximum became more restrictive.
- `PATCH /ticket-types/{ticketTypeId}/batch.requestBody.content.application/json.schema.properties.accessRules.items.properties.value`: maxLength became more restrictive.
- `PATCH /ticket-types/{ticketTypeId}/batch.requestBody.content.application/json.schema.properties.accessRules.items.properties.maxUses`: maximum became more restrictive.
- `GET /ticket-types/{ticketTypeId}/access-rules.parameters.path:ticketTypeId`: minLength became more restrictive.
- `GET /ticket-types/{ticketTypeId}/access-rules.responses.200.content.application/json.schema.properties.items.items`: $ref changed.
- `GET /ticket-types/{ticketTypeId}/access-rules.responses.200.content.application/json.schema.properties.items.items.properties.value`: An enum constraint was introduced.
- `POST /ticket-types/{ticketTypeId}/access-rules.parameters.path:ticketTypeId`: minLength became more restrictive.
- `POST /ticket-types/{ticketTypeId}/access-rules.requestBody.content.application/json.schema.properties.value`: minLength became more restrictive.
- `POST /ticket-types/{ticketTypeId}/access-rules.requestBody.content.application/json.schema.properties.value`: maxLength became more restrictive.
- `POST /ticket-types/{ticketTypeId}/access-rules.requestBody.content.application/json.schema.properties.maxUses`: minimum became more restrictive.
- `POST /ticket-types/{ticketTypeId}/access-rules.requestBody.content.application/json.schema.properties.maxUses`: maximum became more restrictive.
- `POST /ticket-types/{ticketTypeId}/access-rules.requestBody.content.application/json.schema`: Additional properties are no longer accepted.
- `DELETE /access-rules/{accessRuleId}.parameters.path:accessRuleId`: minLength became more restrictive.
- `components.schemas.AccessRulePage.properties.items.items`: $ref changed.
- `components.schemas.AccessRulePage.properties.items.items.properties.value`: An enum constraint was introduced.
- `components.schemas.CreateTicketTypeBatch.properties.accessRules.items.properties.value`: maxLength became more restrictive.
- `components.schemas.CreateTicketTypeBatch.properties.accessRules.items.properties.maxUses`: maximum became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.accessRules.items.properties.value`: maxLength became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.accessRules.items.properties.maxUses`: maximum became more restrictive.
- `components.schemas.AccessRuleCreate.properties.value`: maxLength became more restrictive.
- `components.schemas.AccessRuleCreate.properties.maxUses`: maximum became more restrictive.

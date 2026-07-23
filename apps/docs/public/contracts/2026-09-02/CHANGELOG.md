# API 2026-09-02

Compared with 2026-09-01. Breaking changes: 30. Compatible changes: 29.

- OpenAPI JSON and YAML
- Generated TypeScript declarations
- Webhook event catalog
- Sanitized request/response examples
- Machine-readable API diff and checksums

## Breaking changes

- `PATCH /ticket-types/{ticketTypeId}.requestBody.content.application/json.schema.properties.name`: minLength became more restrictive.
- `PATCH /ticket-types/{ticketTypeId}.requestBody.content.application/json.schema.properties.currency`: pattern changed.
- `PATCH /ticket-types/{ticketTypeId}.requestBody.content.application/json.schema.properties.priceCents`: minimum became more restrictive.
- `PATCH /ticket-types/{ticketTypeId}.requestBody.content.application/json.schema.properties.minimumPriceCents`: minimum became more restrictive.
- `PATCH /ticket-types/{ticketTypeId}.requestBody.content.application/json.schema.properties.minPerOrder`: minimum became more restrictive.
- `PATCH /ticket-types/{ticketTypeId}.requestBody.content.application/json.schema.properties.maxPerOrder`: minimum became more restrictive.
- `PATCH /ticket-types/{ticketTypeId}.requestBody.content.application/json.schema`: Additional properties are no longer accepted.
- `PATCH /ticket-types/{ticketTypeId}/batch.parameters.path:ticketTypeId`: minLength became more restrictive.
- `PATCH /ticket-types/{ticketTypeId}/batch.responses.200.content.application/json.schema`: $ref changed.
- `PATCH /products/{productId}.requestBody.content.application/json.schema.properties.name`: minLength became more restrictive.
- `PATCH /products/{productId}.requestBody.content.application/json.schema.properties.priceCents`: minimum became more restrictive.
- `PATCH /products/{productId}.requestBody.content.application/json.schema.properties.currency`: pattern changed.
- `PATCH /products/{productId}.requestBody.content.application/json.schema.properties.maxPerOrder`: minimum became more restrictive.
- `PATCH /products/{productId}.requestBody.content.application/json.schema`: Additional properties are no longer accepted.
- `GET /exports/{exportId}.parameters.path:exportId`: minLength became more restrictive.
- `GET /exports/{exportId}/events.parameters.path:exportId`: minLength became more restrictive.
- `GET /exports/{exportId}/download.parameters.path:exportId`: minLength became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.ticketType.properties.name`: minLength became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.ticketType.properties.currency`: pattern changed.
- `components.schemas.UpdateTicketTypeBatch.properties.ticketType.properties.priceCents`: minimum became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.ticketType.properties.minimumPriceCents`: minimum became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.ticketType.properties.minPerOrder`: minimum became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.ticketType.properties.maxPerOrder`: minimum became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.ticketType.properties.inventoryPoolId`: minLength became more restrictive.
- `components.schemas.UpdateTicketTypeBatch.properties.ticketType`: Additional properties are no longer accepted.
- `components.schemas.UpdateTicketTypeBatch.properties.accessRules`: maxItems became more restrictive.
- `components.schemas.UpdateTicketTypeBatch`: Additional properties are no longer accepted.
- `components.schemas.AccessRuleCreate.properties.value`: minLength became more restrictive.
- `components.schemas.AccessRuleCreate.properties.maxUses`: minimum became more restrictive.
- `components.schemas.AccessRuleCreate`: Additional properties are no longer accepted.

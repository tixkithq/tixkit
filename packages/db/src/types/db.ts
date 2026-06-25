import type { ColumnType, Generated } from 'kysely';

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface TenantTable {
  id: string;
  name: string;
  status: string;
  plan: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationTable {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  clerk_organization_id: string | null;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BrandTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  slug: string;
  status: string;
  theme: string;
  email_identity_id: string | null;
  sms_identity_id: string | null;
  payment_account_id: string | null;
  support_url: string | null;
  legal_urls: string;
  white_label: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BrandDomainTable {
  id: string;
  brand_id: string;
  domain: string;
  is_primary: boolean;
  is_verified: boolean;
  verification_token: string | null;
  ssl_status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserProfileTable {
  id: string;
  tenant_id: string;
  clerk_user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  status: string;
  last_seen_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ClerkIdentityLinkTable {
  id: string;
  clerk_user_id: string;
  gatekit_user_id: string;
  clerk_organization_id: string | null;
  gatekit_organization_id: string | null;
  last_synced_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrganizationMemberTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  user_id: string;
  role: string;
  invited_at: Timestamp;
  accepted_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RoleTable {
  id: string;
  tenant_id: string;
  name: string;
  permissions: string;
  is_system: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PermissionGrantTable {
  id: string;
  tenant_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  scope_type: string;
  scope_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApiKeyTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  key_prefix: string;
  hashed_key: string;
  scopes: string;
  brand_ids: string | null;
  event_ids: string | null;
  last_used_at: Timestamp | null;
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ScannerDeviceTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  device_id: string;
  hashed_secret: string;
  event_ids: string;
  status: string;
  last_seen_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AuditLogTable {
  id: string;
  tenant_id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  diff_summary: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Timestamp;
}

export interface EventTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  timezone: string;
  starts_at: Timestamp;
  ends_at: Timestamp | null;
  venue: string | null;
  visibility: string;
  seo: string;
  capacity: number | null;
  cover_image_url: string | null;
  external_url: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EventPageTable {
  id: string;
  event_id: string;
  locale: string;
  title: string;
  description: string | null;
  content_html: string | null;
  is_default: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TicketTypeTable {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  kind: string;
  status: string;
  visibility: string;
  currency: string;
  price_cents: number;
  minimum_price_cents: number | null;
  sales_start_at: Timestamp | null;
  sales_end_at: Timestamp | null;
  min_per_order: number;
  max_per_order: number;
  inventory_pool_id: string;
  sort_order: number;
  requires_access_code: boolean;
  access_code_hint: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface InventoryPoolTable {
  id: string;
  event_id: string;
  name: string;
  total_capacity: number;
  reserved_count: Generated<number>;
  sold_count: Generated<number>;
  hold_ttl_seconds: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CheckoutHoldTable {
  id: string;
  inventory_pool_id: string;
  checkout_session_id: string;
  ticket_type_id: string;
  quantity: number;
  expires_at: Timestamp;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CheckoutSessionTable {
  id: string;
  tenant_id: string;
  event_id: string;
  brand_id: string;
  status: string;
  hold_id: string;
  currency: string;
  cart: string;
  buyer: string;
  quote: string;
  payment_intent_id: string | null;
  order_id: string | null;
  success_url: string | null;
  cancel_url: string | null;
  expires_at: Timestamp;
  idempotency_key: string;
  client_token: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  event_id: string;
  checkout_session_id: string;
  order_number: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  fee_cents: number;
  total_cents: number;
  refunded_cents: Generated<number>;
  buyer_email: string;
  buyer_first_name: string | null;
  buyer_last_name: string | null;
  buyer_phone: string | null;
  payment_intent_id: string | null;
  payment_provider: string | null;
  paid_at: Timestamp | null;
  refunded_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderLineItemTable {
  id: string;
  order_id: string;
  ticket_type_id: string;
  attendee_id: string | null;
  description: string;
  quantity: number;
  unit_price_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  fee_cents: number;
  total_cents: number;
  currency: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AttendeeTable {
  id: string;
  tenant_id: string;
  order_id: string;
  event_id: string;
  ticket_type_id: string;
  ticket_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  status: string;
  custom_answers: string | null;
  checked_in_at: Timestamp | null;
  check_in_device_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderTimelineEventTable {
  id: string;
  order_id: string;
  type: string;
  description: string;
  metadata: string | null;
  actor_id: string | null;
  created_at: Timestamp;
}

export interface TicketTable {
  id: string;
  tenant_id: string;
  order_id: string;
  attendee_id: string;
  event_id: string;
  ticket_type_id: string;
  status: string;
  code: string;
  qr_payload: string;
  qr_hash: string;
  transferred_to_email: string | null;
  transferred_at: Timestamp | null;
  checked_in_at: Timestamp | null;
  checked_in_by_device_id: string | null;
  wallet_pass_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TicketSecretTable {
  id: string;
  ticket_id: string;
  key_id: string;
  encrypted_secret: string;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

export interface CheckInListTable {
  id: string;
  event_id: string;
  name: string;
  ticket_type_ids: string;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ScanLogTable {
  id: string;
  tenant_id: string;
  check_in_list_id: string;
  device_id: string;
  ticket_id: string | null;
  qr_hash: string;
  outcome: string;
  scanned_at: Timestamp;
  synced_at: Timestamp | null;
  offline: boolean;
  metadata: string | null;
  created_at: Timestamp;
}

export interface PaymentIntentTable {
  id: string;
  tenant_id: string;
  order_id: string | null;
  checkout_session_id: string;
  provider: string;
  provider_intent_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  client_secret: string | null;
  metadata: string;
  payment_account_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RefundTable {
  id: string;
  tenant_id: string;
  order_id: string;
  payment_intent_id: string | null;
  provider: string;
  provider_refund_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  reason: string;
  metadata: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PaymentEventTable {
  id: string;
  tenant_id: string | null;
  provider: string;
  provider_event_id: string;
  event_type: string;
  raw_payload: string;
  processed_at: Timestamp | null;
  idempotency_key: string;
  created_at: Timestamp;
}

export interface DiscountCodeTable {
  id: string;
  event_id: string;
  code: string;
  type: string;
  value: number;
  currency: string;
  max_uses: number;
  uses_count: Generated<number>;
  valid_from: Timestamp | null;
  valid_until: Timestamp | null;
  min_order_cents: number | null;
  max_discount_cents: number | null;
  ticket_type_ids: string | null;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaxRuleTable {
  id: string;
  event_id: string;
  name: string;
  rate: number;
  type: string;
  applied_to: string;
  countries: string | null;
  regions: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FeeRuleTable {
  id: string;
  event_id: string;
  name: string;
  type: string;
  value: number;
  applied_to: string;
  absorb_into_price: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProductTable {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  category_id: string | null;
  max_per_order: number;
  available_from: Timestamp | null;
  available_until: Timestamp | null;
  status: string;
  sort_order: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProductCategoryTable {
  id: string;
  event_id: string;
  name: string;
  sort_order: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AccessRuleTable {
  id: string;
  ticket_type_id: string;
  type: string;
  value: string;
  max_uses: number | null;
  uses_count: Generated<number>;
  expires_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface QuestionTable {
  id: string;
  event_id: string;
  ticket_type_id: string | null;
  type: string;
  label: string;
  description: string | null;
  required: boolean;
  applies_to: string;
  options: string | null;
  placeholder: string | null;
  validation_pattern: string | null;
  conditional_visibility: string | null;
  sort_order: number;
  is_consent_field: boolean;
  consent_text: string | null;
  consent_version: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebhookEndpointTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  url: string;
  secret: string;
  events: string;
  status: string;
  description: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebhookEventTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  type: string;
  payload: string;
  status: string;
  created_at: Timestamp;
}

export interface WebhookDeliveryTable {
  id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
  status_code: number | null;
  response: string | null;
  status: string;
  delivered_at: Timestamp | null;
  next_retry_at: Timestamp | null;
  created_at: Timestamp;
}

export interface IdempotencyRecordTable {
  id: string;
  key: string;
  tenant_id: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  status: string;
  created_at: Timestamp;
  expires_at: Timestamp;
}

export interface AffiliateTable {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  commission_percentage: number;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AttributionTable {
  id: string;
  order_id: string;
  affiliate_id: string;
  affiliate_code: string;
  commission_cents: number;
  attributed_at: Timestamp;
  created_at: Timestamp;
}

export interface NotificationTemplateTable {
  id: string;
  tenant_id: string;
  brand_id: string | null;
  key: string;
  name: string;
  description: string | null;
  category: string;
  variables: string;
  current_version_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface NotificationTemplateVersionTable {
  id: string;
  template_id: string;
  version: number;
  subject_template: string;
  html_template: string;
  text_template: string | null;
  locale: string;
  is_default: boolean;
  published_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EmailJobTable {
  id: string;
  tenant_id: string;
  brand_id: string;
  template_key: string;
  template_version_id: string;
  to_email: string;
  to_name: string | null;
  variables: string;
  provider_route_id: string;
  status: string;
  priority: string;
  scheduled_at: Timestamp | null;
  idempotency_key: string;
  workflow_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EmailDeliveryTable {
  id: string;
  tenant_id: string;
  job_id: string;
  provider: string;
  provider_message_id: string | null;
  status: string;
  attempted_providers: string;
  accepted_provider: string | null;
  sent_at: Timestamp | null;
  delivered_at: Timestamp | null;
  bounced_at: Timestamp | null;
  bounce_reason: string | null;
  metadata: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EmailSuppressionTable {
  id: string;
  tenant_id: string;
  email: string;
  reason: string;
  bounce_type: string | null;
  source: string;
  created_at: Timestamp;
}

export interface EmailProviderRouteTable {
  id: string;
  tenant_id: string;
  brand_id: string;
  provider_type: string;
  credentials_ref: string;
  sender_domain: string;
  priority: number;
  is_fallback: boolean;
  rate_limit_per_hour: number | null;
  allowed_categories: string;
  status: string;
  smoke_send_verified: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BrandSenderIdentityTable {
  id: string;
  tenant_id: string;
  brand_id: string;
  email: string;
  name: string;
  reply_to_email: string | null;
  verified: boolean;
  verified_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SmsSenderIdentityTable {
  id: string;
  tenant_id: string;
  brand_id: string;
  sender: string;
  kind: string;
  provider_type: string;
  provider_sender_id: string | null;
  verified: boolean;
  verified_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SmsProviderRouteTable {
  id: string;
  tenant_id: string;
  brand_id: string;
  provider_type: string;
  credentials_ref: string;
  sender_identity_id: string;
  priority: number;
  is_fallback: boolean;
  rate_limit_per_hour: number | null;
  allowed_categories: string;
  status: string;
  smoke_send_verified: boolean;
  webhook_url: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SmsJobTable {
  id: string;
  tenant_id: string;
  brand_id: string;
  to_phone: string;
  body: string;
  template_key: string | null;
  variables: string;
  provider_route_id: string;
  status: string;
  priority: string;
  scheduled_at: Timestamp | null;
  idempotency_key: string;
  workflow_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SmsDeliveryTable {
  id: string;
  tenant_id: string;
  job_id: string;
  provider: string;
  provider_message_id: string | null;
  status: string;
  attempted_providers: string;
  accepted_provider: string | null;
  sent_at: Timestamp | null;
  delivered_at: Timestamp | null;
  failed_at: Timestamp | null;
  failure_reason: string | null;
  metadata: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SmsProviderEventTable {
  id: string;
  tenant_id: string | null;
  provider: string;
  provider_event_id: string;
  event_type: string;
  provider_message_id: string | null;
  raw_payload: string;
  processed_at: Timestamp | null;
  created_at: Timestamp;
}

export interface MessageConsentTable {
  id: string;
  tenant_id: string;
  attendee_id: string;
  email: string;
  phone: string | null;
  email_opt_in: boolean;
  sms_opt_in: boolean;
  consent_text: string;
  consent_version: string;
  consented_at: Timestamp;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

export interface ExportJobTable {
  id: string;
  tenant_id: string;
  event_id: string | null;
  type: string;
  format: string;
  status: string;
  file_url: string | null;
  requested_by: string;
  filters: string | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface ExportJobEventTable {
  id: string;
  tenant_id: string;
  export_job_id: string;
  status: string;
  payload: string;
  created_at: Timestamp;
}

export interface PaymentAccountTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  provider: string;
  provider_account_id: string;
  status: string;
  default_currency: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SenderIdentityTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  email: string;
  name: string;
  verified: boolean;
  provider_type: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FeatureFlagTable {
  id: string;
  tenant_id: string;
  key: string;
  enabled: boolean;
  config: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OAuthApplicationTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  client_id: string;
  client_secret_hash: string;
  redirect_uris: string;
  scopes: string;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DB {
  tenants: TenantTable;
  organizations: OrganizationTable;
  brands: BrandTable;
  brand_domains: BrandDomainTable;
  user_profiles: UserProfileTable;
  clerk_identity_links: ClerkIdentityLinkTable;
  organization_members: OrganizationMemberTable;
  roles: RoleTable;
  permission_grants: PermissionGrantTable;
  api_keys: ApiKeyTable;
  scanner_devices: ScannerDeviceTable;
  audit_logs: AuditLogTable;
  events: EventTable;
  event_pages: EventPageTable;
  ticket_types: TicketTypeTable;
  inventory_pools: InventoryPoolTable;
  checkout_holds: CheckoutHoldTable;
  checkout_sessions: CheckoutSessionTable;
  orders: OrderTable;
  order_line_items: OrderLineItemTable;
  attendees: AttendeeTable;
  order_timeline_events: OrderTimelineEventTable;
  tickets: TicketTable;
  ticket_secrets: TicketSecretTable;
  check_in_lists: CheckInListTable;
  scan_logs: ScanLogTable;
  payment_intents: PaymentIntentTable;
  refunds: RefundTable;
  payment_events: PaymentEventTable;
  discount_codes: DiscountCodeTable;
  tax_rules: TaxRuleTable;
  fee_rules: FeeRuleTable;
  products: ProductTable;
  product_categories: ProductCategoryTable;
  access_rules: AccessRuleTable;
  questions: QuestionTable;
  webhook_endpoints: WebhookEndpointTable;
  webhook_events: WebhookEventTable;
  webhook_deliveries: WebhookDeliveryTable;
  idempotency_records: IdempotencyRecordTable;
  affiliates: AffiliateTable;
  attributions: AttributionTable;
  notification_templates: NotificationTemplateTable;
  notification_template_versions: NotificationTemplateVersionTable;
  email_jobs: EmailJobTable;
  email_deliveries: EmailDeliveryTable;
  email_suppressions: EmailSuppressionTable;
  email_provider_routes: EmailProviderRouteTable;
  brand_sender_identities: BrandSenderIdentityTable;
  sms_sender_identities: SmsSenderIdentityTable;
  sms_provider_routes: SmsProviderRouteTable;
  sms_jobs: SmsJobTable;
  sms_deliveries: SmsDeliveryTable;
  sms_provider_events: SmsProviderEventTable;
  message_consents: MessageConsentTable;
  export_jobs: ExportJobTable;
  export_job_events: ExportJobEventTable;
  payment_accounts: PaymentAccountTable;
  sender_identities: SenderIdentityTable;
  feature_flags: FeatureFlagTable;
  oauth_applications: OAuthApplicationTable;
}

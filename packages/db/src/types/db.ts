import type { ColumnType, Generated } from 'kysely';
import type { BoxOfficeTenderType, SalesChannel } from '@tixkit/domain';

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type OrganizationBoxOfficeSettings = {
  enabled: boolean;
  allowedTenderTypes: BoxOfficeTenderType[];
  requireBuyerEmail: boolean;
  receiptMode: 'print' | 'email' | 'both';
};

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
  box_office_settings: OrganizationBoxOfficeSettings | string;
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
  tixkit_user_id: string;
  clerk_organization_id: string | null;
  tixkit_organization_id: string | null;
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
  scopes: string;
  status: string;
  last_seen_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AuditLogTable {
  id: string;
  tenant_id: string;
  organization_id: string | null;
  brand_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  diff_summary: string | null;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Timestamp;
}

export interface PrivacyRequestTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string | null;
  request_type: string;
  subject_type: string;
  subject_id: string | null;
  subject_email: string | null;
  status: string;
  requested_by: string;
  result: string | null;
  error: string | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
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
  currency: string;
  timezone: string;
  starts_at: Timestamp;
  ends_at: Timestamp | null;
  venue: string | null;
  visibility: string;
  seo: string;
  capacity: number | null;
  minimum_age: number | null;
  cover_image_url: string | null;
  external_url: string | null;
  waitlist_auto_offer_enabled: Generated<boolean>;
  waitlist_offer_ttl_minutes: Generated<number>;
  resale_enabled: Generated<boolean>;
  resale_max_multiplier: Generated<number>;
  resale_max_absolute_cents: number | null;
  pass_fees_to_buyer: Generated<boolean>;
  code_format: string | null;
  public_revision: Timestamp | null;
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

export interface EventOccurrenceTable {
  id: string;
  event_id: string;
  title: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  timezone: string;
  venue: string | null;
  capacity: number | null;
  sort_order: number;
  status: string;
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
  event_occurrence_id: string | null;
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
  event_occurrence_id: string | null;
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
  hold_id: string | null;
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
  buyer_date_of_birth: string | null;
  payment_intent_id: string | null;
  payment_provider: string | null;
  sales_channel: Generated<SalesChannel>;
  operator_id: string | null;
  tender_type: BoxOfficeTenderType | null;
  paid_at: Timestamp | null;
  refunded_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderLineItemTable {
  id: string;
  order_id: string;
  ticket_type_id: string | null;
  product_id: string | null;
  event_occurrence_id: string | null;
  resale_listing_id: string | null;
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

export interface OrderTaxSnapshotTable {
  id: string;
  order_id: string;
  order_line_item_id: string;
  event_id: string;
  tax_rule_id: string | null;
  tax_rule_name: string;
  rate: number;
  type: string;
  applied_to: string;
  jurisdiction_country: string | null;
  jurisdiction_region: string | null;
  taxable_amount_cents: number;
  tax_cents: number;
  currency: string;
  inclusive: Generated<boolean>;
  provider: Generated<string>;
  provider_calculation_id: string | null;
  metadata: string | null;
  created_at: Timestamp;
}

export interface InvoiceTable {
  id: string;
  order_id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  event_id: string;
  invoice_number: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  fee_cents: number;
  total_cents: number;
  refunded_cents: Generated<number>;
  buyer_email: string;
  buyer_name: string | null;
  buyer_tax_id: string | null;
  seller_name: string;
  seller_tax_id: string | null;
  reverse_charge: Generated<boolean>;
  issued_at: Timestamp;
  voided_at: Timestamp | null;
  metadata: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AttendeeTable {
  id: string;
  tenant_id: string;
  order_id: string;
  event_id: string;
  event_occurrence_id: string | null;
  ticket_type_id: string;
  ticket_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  date_of_birth: string | null;
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
  event_occurrence_id: string | null;
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

export interface TicketListingTable {
  id: string;
  tenant_id: string;
  event_id: string;
  ticket_id: string;
  seller_id: string;
  status: 'listed' | 'delisted' | 'sold' | 'expired';
  price_cents: number | string;
  currency: string;
  face_value_cents: number | string;
  sold_to_id: string | null;
  active_listing_key: string;
  reserved_checkout_session_id: string | null;
  reserved_until: Timestamp | null;
  expires_at: Timestamp | null;
  sold_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WalletPassTable {
  id: string;
  tenant_id: string;
  ticket_id: string;
  provider: string;
  status: string;
  serial_number: string;
  pass_url: string;
  access_token_hash: string | null;
  content_type: string | null;
  artifact_base64: string | null;
  metadata: string;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UploadArtifactTable {
  id: string;
  tenant_id: string;
  organization_id: string | null;
  brand_id: string | null;
  event_id: string | null;
  created_by_user_id: string | null;
  purpose: string;
  status: string;
  scan_status: string;
  scan_result: string | null;
  bucket: string;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string | null;
  client_token_hash: string | null;
  metadata: string;
  consumed_by_checkout_session_id: string | null;
  consumed_at: Timestamp | null;
  expires_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WidgetImpressionTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  event_id: string;
  visitor_hash: string;
  impression_date: string;
  source: string;
  tracking_id: string | null;
  affiliate_code: string | null;
  host: string | null;
  page_url: string | null;
  referrer: string | null;
  created_at: Timestamp;
}

export interface WaitlistEntryTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  event_id: string;
  ticket_type_id: string;
  buyer_email: string;
  buyer_first_name: string | null;
  buyer_last_name: string | null;
  buyer_phone: string | null;
  quantity: number;
  status: string;
  offer_expires_at: Timestamp | null;
  claim_token_hash: string | null;
  reserved_checkout_session_id: string | null;
  reserved_until: Timestamp | null;
  offered_at: Timestamp | null;
  claimed_at: Timestamp | null;
  cancelled_at: Timestamp | null;
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
  event_occurrence_id: string | null;
  name: string;
  ticket_type_ids: string;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  next_activity_sequence: Generated<number | string | bigint>;
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
  activity_sequence: Generated<number | string | bigint>;
}

export interface OfflineCheckInSyncJobTable {
  id: string;
  tenant_id: string;
  event_id: string;
  check_in_list_id: string;
  device_id: string;
  requested_by_principal_id: string;
  total_chunks: number;
  total_scans: number | null;
  chunks_received: number;
  chunks_processed: number;
  accepted_count: number;
  duplicate_count: number;
  invalid_count: number;
  sample_errors: string;
  status: string;
  failure_message: string | null;
  attempt_count: number;
  lease_owner: string | null;
  leased_until: Timestamp | null;
  next_attempt_at: Timestamp | null;
  last_attempted_at: Timestamp | null;
  last_heartbeat_at: Timestamp | null;
  processing_started_at: Timestamp | null;
  processing_completed_at: Timestamp | null;
  processing_duration_ms: number;
  transaction_duration_ms: number;
  lock_wait_ms: number;
  scan_log_insert_duration_ms: number;
  ticket_update_duration_ms: number;
  attendee_update_duration_ms: number;
  rows_processed: number;
  clock_warning_count: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface OfflineCheckInSyncChunkTable {
  id: string;
  tenant_id: string;
  job_id: string;
  sequence: number;
  scan_count: number;
  payload_hash: string;
  payload: string | null;
  accepted_count: number;
  duplicate_count: number;
  invalid_count: number;
  sample_errors: string;
  clock_warning_count: number;
  status: string;
  attempt_count: number;
  failure_message: string | null;
  locked_at: Timestamp | null;
  processed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
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
  request_idempotency_key: string | null;
  request_nonce: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  reason: string;
  metadata: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PaymentCompensationTable {
  id: string;
  tenant_id: string;
  checkout_session_id: string;
  payment_intent_id: string | null;
  provider: string;
  provider_intent_id: string;
  amount_cents: number;
  currency: string;
  action: string;
  status: string;
  provider_compensation_id: string | null;
  attempts: number;
  reason: string;
  last_error: string | null;
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
  recovery_status: string;
  recovery_attempts: number;
  recovery_owner: string | null;
  recovery_claimed_until: Timestamp | null;
  next_recovery_at: Timestamp | null;
  last_recovery_error: string | null;
  recovery_updated_at: Timestamp | null;
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

export interface DiscountRedemptionTable {
  id: string;
  discount_code_id: string;
  event_id: string;
  checkout_session_id: string;
  order_id: string | null;
  tenant_id: string | null;
  created_at: Timestamp;
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

export interface AccessRuleRedemptionTable {
  id: string;
  access_rule_id: string;
  ticket_type_id: string;
  event_id: string;
  checkout_session_id: string;
  order_id: string | null;
  tenant_id: string | null;
  created_at: Timestamp;
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
  status: Generated<string>;
  is_hidden: Generated<boolean>;
  hidden_at: Timestamp | null;
  deleted_at: Timestamp | null;
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

export interface SandboxEnvironmentTable {
  id: string;
  epoch: string;
  task_queue: string;
  fixture_version: number;
  reset_at: Timestamp;
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
  endpoint_id: string | null;
  requested_endpoint_id: string;
  delivery_key: string;
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
  tenant_id: string | null;
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

export interface EmailProviderEventTable {
  id: string;
  tenant_id: string | null;
  provider: string;
  provider_event_id: string;
  event_type: string;
  provider_message_id: string | null;
  email: string | null;
  raw_payload: string;
  processed_at: Timestamp | null;
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
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements: string | null;
  disabled_reason: string | null;
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

export interface OAuthAuthorizationCodeTable {
  id: string;
  oauth_application_id: string;
  tenant_id: string;
  organization_id: string;
  user_id: string | null;
  code_hash: string;
  redirect_uri: string;
  scopes: string;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
  created_at: Timestamp;
}

export interface OAuthRefreshTokenTable {
  id: string;
  oauth_application_id: string;
  tenant_id: string;
  organization_id: string;
  token_hash: string;
  scopes: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OAuthAccessTokenTable {
  id: string;
  oauth_application_id: string;
  refresh_token_id: string | null;
  tenant_id: string;
  organization_id: string;
  token_hash: string;
  scopes: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MarketingIntegrationTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  event_id: string | null;
  provider: string;
  config: string;
  consent_required: boolean;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ShortLinkTable {
  id: string;
  tenant_id: string;
  brand_id: string | null;
  slug: string;
  destination_url: string;
  utm_params: string | null;
  clicks: number;
  expires_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LinkClickTable {
  id: string;
  short_link_id: string;
  tenant_id: string;
  day_bucket: string;
  created_at: Timestamp;
}

export interface ContentDocumentTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  event_id: string | null;
  channel: string;
  key: string;
  name: string;
  status: string;
  locale: string;
  current_draft_version_id: string | null;
  published_version_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ContentDocumentVersionTable {
  id: string;
  document_id: string;
  version_number: number;
  status: string;
  schema_version: number;
  subject: string | null;
  preview_text: string | null;
  content_json: string;
  rendered_html: string | null;
  rendered_text: string | null;
  variables: string;
  validation: string;
  created_by: string;
  created_at: Timestamp;
  published_at: Timestamp | null;
}

export interface ContentAssetTable {
  id: string;
  tenant_id: string;
  document_id: string;
  version_id: string | null;
  storage_key: string;
  content_type: string;
  bytes: number;
  created_at: Timestamp;
}

export interface ContentRenderArtifactTable {
  id: string;
  tenant_id: string;
  document_id: string;
  version_id: string;
  channel: string;
  output_type: string;
  artifact_ref: string;
  checksum: string;
  created_at: Timestamp;
}

export interface ContentTestSendTable {
  id: string;
  tenant_id: string;
  document_id: string;
  version_id: string;
  channel: string;
  recipient: string;
  status: string;
  rendered_subject: string | null;
  rendered_html: string | null;
  rendered_text: string | null;
  error: string | null;
  created_at: Timestamp;
}

export interface MigrationCredentialTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  source_system: string;
  secret_reference: string;
  status: string;
  expires_at: Timestamp;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ImportJobTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  source_system: string;
  adapter_version: string;
  mode: string;
  status: string;
  idempotency_key: string;
  requested_by: string;
  configuration: string | null;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  activated_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ImportJobFileTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  import_job_id: string;
  object_key: string;
  original_name: string;
  media_type: string;
  byte_size: string | number | bigint;
  sha256: string;
  status: string;
  created_at: Timestamp;
}

export interface ImportJobRowTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  import_job_id: string;
  import_job_file_id: string | null;
  entity_type: string;
  external_id: string | null;
  row_number: number;
  status: string;
  claim_owner: string | null;
  claim_attempt: Generated<number>;
  claim_expires_at: Timestamp | null;
  severity: string | null;
  source_data: string;
  normalized_data: string | null;
  tixkit_id: string | null;
  created_entity: Generated<boolean>;
  domain_activity_at: Timestamp | null;
  rollback_blocked_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ImportJobEventTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  import_job_id: string;
  sequence: number;
  event_key: string;
  type: string;
  severity: string;
  message: string;
  data: string | null;
  created_at: Timestamp;
}

export interface ImportMappingTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  source_system: string;
  name: string;
  entity_type: string;
  mapping: string;
  version: number;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ExternalReferenceTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  source_system: string;
  entity_type: string;
  external_id: string;
  tixkit_id: string;
  created_by_import_job_id: string | null;
  last_seen_import_job_id: string;
  source_provenance: string | null;
  rollback_blocked_at: Timestamp | null;
  rollback_blocked_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ImportConflictTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  import_job_id: string;
  import_job_row_id: string | null;
  code: string;
  severity: string;
  entity_type: string;
  external_id: string | null;
  message: string;
  details: string | null;
  resolution: string | null;
  resolved_at: Timestamp | null;
  created_at: Timestamp;
}

export interface ImportedDomainEntityTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  created_by_import_job_id: string;
  last_seen_import_job_id: string;
  source_system: string;
  entity_type: string;
  source_external_id: string;
  attributes: string;
  financial_snapshot: string | null;
  source_provenance: string;
  canonical_hash: string;
  side_effects_suppressed: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ImportedEntityDependencyTable {
  tenant_id: string;
  organization_id: string;
  entity_id: string;
  depends_on_entity_id: string;
  created_at: Timestamp;
}

export interface VenueTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  address: string | null;
  timezone: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BuyerTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface HistoricalFinancialSnapshotTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  order_id: string;
  kind: string;
  amount_minor: string | number | bigint;
  currency: string;
  provider_reference: string | null;
  occurred_at: Timestamp;
  provenance: string;
  reconciliation_status: string;
  created_at: Timestamp;
}

export interface HistoricalCheckInTable {
  id: string;
  tenant_id: string;
  organization_id: string;
  ticket_id: string;
  occurred_at: Timestamp;
  result: string;
  provenance: string;
  created_at: Timestamp;
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
  privacy_requests: PrivacyRequestTable;
  events: EventTable;
  event_pages: EventPageTable;
  event_occurrences: EventOccurrenceTable;
  ticket_types: TicketTypeTable;
  inventory_pools: InventoryPoolTable;
  checkout_holds: CheckoutHoldTable;
  checkout_sessions: CheckoutSessionTable;
  orders: OrderTable;
  order_line_items: OrderLineItemTable;
  order_tax_snapshots: OrderTaxSnapshotTable;
  invoices: InvoiceTable;
  attendees: AttendeeTable;
  order_timeline_events: OrderTimelineEventTable;
  tickets: TicketTable;
  ticket_listings: TicketListingTable;
  wallet_passes: WalletPassTable;
  upload_artifacts: UploadArtifactTable;
  widget_impressions: WidgetImpressionTable;
  waitlist_entries: WaitlistEntryTable;
  ticket_secrets: TicketSecretTable;
  check_in_lists: CheckInListTable;
  scan_logs: ScanLogTable;
  offline_check_in_sync_jobs: OfflineCheckInSyncJobTable;
  offline_check_in_sync_chunks: OfflineCheckInSyncChunkTable;
  payment_intents: PaymentIntentTable;
  refunds: RefundTable;
  payment_compensations: PaymentCompensationTable;
  payment_events: PaymentEventTable;
  discount_codes: DiscountCodeTable;
  discount_redemptions: DiscountRedemptionTable;
  tax_rules: TaxRuleTable;
  fee_rules: FeeRuleTable;
  products: ProductTable;
  product_categories: ProductCategoryTable;
  access_rules: AccessRuleTable;
  access_rule_redemptions: AccessRuleRedemptionTable;
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
  email_provider_events: EmailProviderEventTable;
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
  oauth_authorization_codes: OAuthAuthorizationCodeTable;
  oauth_refresh_tokens: OAuthRefreshTokenTable;
  oauth_access_tokens: OAuthAccessTokenTable;
  marketing_integrations: MarketingIntegrationTable;
  short_links: ShortLinkTable;
  link_clicks: LinkClickTable;
  content_documents: ContentDocumentTable;
  content_document_versions: ContentDocumentVersionTable;
  content_assets: ContentAssetTable;
  content_render_artifacts: ContentRenderArtifactTable;
  content_test_sends: ContentTestSendTable;
  sandbox_environments: SandboxEnvironmentTable;
  import_jobs: ImportJobTable;
  migration_credentials: MigrationCredentialTable;
  import_job_files: ImportJobFileTable;
  import_job_rows: ImportJobRowTable;
  import_job_events: ImportJobEventTable;
  import_mappings: ImportMappingTable;
  external_references: ExternalReferenceTable;
  import_conflicts: ImportConflictTable;
  imported_domain_entities: ImportedDomainEntityTable;
  imported_entity_dependencies: ImportedEntityDependencyTable;
  venues: VenueTable;
  buyers: BuyerTable;
  historical_financial_snapshots: HistoricalFinancialSnapshotTable;
  historical_check_ins: HistoricalCheckInTable;
}

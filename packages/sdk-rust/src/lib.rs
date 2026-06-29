//! Async Rust SDK for Tixkit.
//!
//! The client is pinned to API version `2026-01-01` by default and sends the
//! `X-Tixkit-Version` header on every request.

use futures_util::{Stream, stream};
use hmac::{Hmac, KeyInit, Mac};
use reqwest::StatusCode;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sha2::Sha256;
use std::collections::VecDeque;
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;

pub const TIXKIT_API_VERSION: &str = "2026-01-01";

type HmacSha256 = Hmac<Sha256>;
type BoxStreamResult<T> = Pin<Box<dyn Stream<Item = Result<T, TixkitError>> + Send>>;

#[derive(Clone, Debug)]
pub struct TixkitClient {
    http: reqwest::Client,
    api_key: Option<String>,
    api_base_url: String,
    api_version: String,
    max_retries: usize,
    retry_backoff: Duration,
}

#[derive(Clone, Debug)]
pub struct TixkitClientBuilder {
    api_key: Option<String>,
    api_base_url: String,
    api_version: String,
    timeout: Duration,
    max_retries: usize,
    retry_backoff: Duration,
    http: Option<reqwest::Client>,
}

impl Default for TixkitClientBuilder {
    fn default() -> Self {
        Self {
            api_key: None,
            api_base_url: "https://api.tixkit.com".to_string(),
            api_version: TIXKIT_API_VERSION.to_string(),
            timeout: Duration::from_secs(30),
            max_retries: 3,
            retry_backoff: Duration::from_millis(250),
            http: None,
        }
    }
}

impl TixkitClientBuilder {
    pub fn api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    pub fn api_base_url(mut self, api_base_url: impl Into<String>) -> Self {
        self.api_base_url = api_base_url.into();
        self
    }

    pub fn api_version(mut self, api_version: impl Into<String>) -> Self {
        self.api_version = api_version.into();
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn max_retries(mut self, max_retries: usize) -> Self {
        self.max_retries = max_retries;
        self
    }

    pub fn retry_backoff(mut self, retry_backoff: Duration) -> Self {
        self.retry_backoff = retry_backoff;
        self
    }

    pub fn http_client(mut self, http: reqwest::Client) -> Self {
        self.http = Some(http);
        self
    }

    pub fn build(self) -> Result<TixkitClient, TixkitError> {
        let http = match self.http {
            Some(http) => http,
            None => reqwest::Client::builder()
                .timeout(self.timeout)
                .build()
                .map_err(TixkitError::transport)?,
        };

        Ok(TixkitClient {
            http,
            api_key: self.api_key,
            api_base_url: normalize_api_base_url(&self.api_base_url),
            api_version: self.api_version,
            max_retries: self.max_retries,
            retry_backoff: self.retry_backoff,
        })
    }
}

impl TixkitClient {
    pub fn builder() -> TixkitClientBuilder {
        TixkitClientBuilder::default()
    }

    pub fn checkout(&self) -> CheckoutResource<'_> {
        CheckoutResource { client: self }
    }

    pub fn events(&self) -> EventResource<'_> {
        EventResource { client: self }
    }

    pub fn public(&self) -> PublicResource<'_> {
        PublicResource { client: self }
    }

    pub fn ticket_types(&self) -> TicketTypeResource<'_> {
        TicketTypeResource { client: self }
    }

    pub fn orders(&self) -> OrderResource<'_> {
        OrderResource { client: self }
    }

    pub fn refunds(&self) -> RefundResource<'_> {
        RefundResource { client: self }
    }

    pub fn attendees(&self) -> AttendeeResource<'_> {
        AttendeeResource { client: self }
    }

    pub fn check_ins(&self) -> CheckInResource<'_> {
        CheckInResource { client: self }
    }

    pub fn questions(&self) -> QuestionResource<'_> {
        QuestionResource { client: self }
    }

    pub fn waitlist(&self) -> WaitlistResource<'_> {
        WaitlistResource { client: self }
    }

    pub fn reports(&self) -> ReportResource<'_> {
        ReportResource { client: self }
    }

    pub fn exports(&self) -> ExportResource<'_> {
        ExportResource { client: self }
    }

    pub fn webhook_endpoints(&self) -> WebhookEndpointResource<'_> {
        WebhookEndpointResource { client: self }
    }

    pub fn api_keys(&self) -> ApiKeyResource<'_> {
        ApiKeyResource { client: self }
    }

    async fn request<T, B>(
        &self,
        method: reqwest::Method,
        path: &str,
        options: RequestOptions<B>,
    ) -> Result<T, TixkitError>
    where
        T: DeserializeOwned,
        B: Serialize + Clone,
    {
        let retryable = method == reqwest::Method::GET || options.idempotency_key.is_some();
        let mut last_error = None;

        for attempt in 0..=self.max_retries {
            let mut request = self
                .http
                .request(method.clone(), self.url(path, options.query.as_ref())?)
                .header("X-Tixkit-Version", &self.api_version);

            if let Some(api_key) = &self.api_key {
                request = request.bearer_auth(api_key);
            }
            if let Some(idempotency_key) = &options.idempotency_key {
                request = request.header("Idempotency-Key", idempotency_key);
            }
            for (name, value) in &options.headers {
                request = request.header(name, value);
            }
            if let Some(body) = &options.body {
                request = request.json(body);
            }

            match send_json::<T>(request).await {
                Ok(value) => return Ok(value),
                Err(error) => {
                    let should_retry =
                        retryable && error.is_retryable() && attempt < self.max_retries;
                    last_error = Some(error);
                    if should_retry {
                        tokio::time::sleep(self.backoff_for(attempt)).await;
                        continue;
                    }
                    break;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| TixkitError::message("request failed")))
    }

    fn url(
        &self,
        path: &str,
        query: Option<&Vec<(String, String)>>,
    ) -> Result<reqwest::Url, TixkitError> {
        let mut url = reqwest::Url::parse(&format!("{}/v1{}", self.api_base_url, path))
            .map_err(|error| TixkitError::configuration(format!("invalid API URL: {error}")))?;
        if let Some(query) = query {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(k, v)| (&**k, &**v)));
        }
        Ok(url)
    }

    fn backoff_for(&self, attempt: usize) -> Duration {
        let factor = 2_u32.saturating_pow(attempt as u32);
        self.retry_backoff
            .checked_mul(factor)
            .unwrap_or(Duration::from_secs(10))
            .min(Duration::from_secs(10))
    }
}

async fn send_json<T>(request: reqwest::RequestBuilder) -> Result<T, TixkitError>
where
    T: DeserializeOwned,
{
    let response = request.send().await.map_err(TixkitError::transport)?;
    let status = response.status();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = response.text().await.map_err(TixkitError::transport)?;
    if !status.is_success() {
        return Err(api_error_from_response(status, request_id, &text));
    }
    if text.trim().is_empty() {
        return serde_json::from_str("null").map_err(TixkitError::decode);
    }
    serde_json::from_str(&text).map_err(TixkitError::decode)
}

fn api_error_from_response(
    status: StatusCode,
    fallback_request_id: String,
    text: &str,
) -> TixkitError {
    let payload = serde_json::from_str::<Value>(text).ok();
    let error = payload
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(Value::as_object);
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("HTTP_{}", status.as_u16()));
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Request failed with status {}", status.as_u16()));
    let request_id = error
        .and_then(|error| error.get("requestId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or(fallback_request_id);
    let details = error
        .and_then(|error| error.get("details"))
        .cloned()
        .unwrap_or(Value::Null);

    TixkitError::Api(ApiError {
        status,
        code,
        message,
        request_id,
        details,
    })
}

fn normalize_api_base_url(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

#[derive(Clone, Debug)]
struct RequestOptions<B> {
    body: Option<B>,
    idempotency_key: Option<String>,
    query: Option<Vec<(String, String)>>,
    headers: Vec<(String, String)>,
}

impl<B> RequestOptions<B> {
    fn body(body: B) -> Self {
        Self {
            body: Some(body),
            ..Self::default()
        }
    }

    fn query(query: Vec<(String, String)>) -> Self {
        Self {
            query: Some(query),
            ..Self::default()
        }
    }

    fn idempotency_key(mut self, idempotency_key: Option<String>) -> Self {
        self.idempotency_key = idempotency_key;
        self
    }

    fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

impl<B> Default for RequestOptions<B> {
    fn default() -> Self {
        Self {
            body: None,
            idempotency_key: None,
            query: None,
            headers: Vec::new(),
        }
    }
}

#[derive(Debug, Error)]
pub enum TixkitError {
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error("Tixkit transport error: {0}")]
    Transport(#[source] reqwest::Error),
    #[error("Tixkit decode error: {0}")]
    Decode(#[source] serde_json::Error),
    #[error("Tixkit configuration error: {0}")]
    Configuration(String),
    #[error("Tixkit webhook signature error: {0}")]
    WebhookSignature(String),
}

impl TixkitError {
    fn transport(error: reqwest::Error) -> Self {
        Self::Transport(error)
    }

    fn decode(error: serde_json::Error) -> Self {
        Self::Decode(error)
    }

    fn configuration(message: String) -> Self {
        Self::Configuration(message)
    }

    fn message(message: impl Into<String>) -> Self {
        Self::Configuration(message.into())
    }

    fn is_retryable(&self) -> bool {
        match self {
            Self::Api(source) => {
                source.status.is_server_error() || source.status == StatusCode::TOO_MANY_REQUESTS
            }
            Self::Transport(_) => true,
            _ => false,
        }
    }
}

#[derive(Debug, Error, Clone)]
#[error("{code}: {message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub request_id: String,
    pub details: Value,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageParams {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

impl PageParams {
    fn to_query(&self) -> Vec<(String, String)> {
        let mut query = Vec::new();
        if let Some(cursor) = &self.cursor {
            query.push(("cursor".to_string(), cursor.clone()));
        }
        if let Some(limit) = self.limit {
            query.push(("limit".to_string(), limit.to_string()));
        }
        query
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub tenant_id: Option<String>,
    pub organization_id: Option<String>,
    pub brand_id: Option<String>,
    pub slug: Option<String>,
    pub title: String,
    pub status: Option<String>,
    pub currency: Option<String>,
    pub timezone: Option<String>,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicContentPage {
    pub document: PublicContentDocument,
    pub version: PublicContentVersion,
    pub page: PublicEventPage,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicContentDocument {
    pub event_id: String,
    pub channel: String,
    pub key: String,
    pub name: String,
    pub locale: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicContentVersion {
    pub version_number: u32,
    pub subject: Option<String>,
    pub preview_text: Option<String>,
    pub rendered_html: Option<String>,
    pub rendered_text: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventPage {
    pub html: String,
    pub text: String,
    pub headless: Vec<PublicEventPageBlock>,
    pub discovery: PublicEventDiscoveryCard,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventPageBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub id: String,
    pub title: Option<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub image_url: Option<String>,
    pub image_alt: Option<String>,
    pub links: Option<Vec<PublicPageLink>>,
    pub items: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicPageLink {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventDiscoveryCard {
    pub title: String,
    pub summary: String,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub image_url: Option<String>,
    pub starts_at: Option<String>,
    pub venue_name: Option<String>,
    pub public_path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventPageParams {
    pub locale: Option<String>,
}

impl PublicEventPageParams {
    fn to_query(&self) -> Vec<(String, String)> {
        let mut query = Vec::new();
        if let Some(locale) = &self.locale {
            query.push(("locale".to_string(), locale.clone()));
        }
        query
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventPageBySlugParams {
    pub host: String,
    pub locale: Option<String>,
}

impl PublicEventPageBySlugParams {
    fn to_query(&self) -> Vec<(String, String)> {
        let mut query = vec![("host".to_string(), self.host.clone())];
        if let Some(locale) = &self.locale {
            query.push(("locale".to_string(), locale.clone()));
        }
        query
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TicketType {
    pub id: String,
    pub event_id: String,
    pub name: String,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub currency: Option<String>,
    pub price_cents: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket_type_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurrence_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    pub quantity: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_amount_cents: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attendee_fields: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Buyer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCheckoutSession {
    pub event_id: String,
    pub items: Vec<CheckoutItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer: Option<Buyer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer_fields: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discount_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affiliate_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancel_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waitlist_claim_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutSession {
    pub id: String,
    pub event_id: String,
    pub brand_id: Option<String>,
    pub status: String,
    pub currency: String,
    pub client_token: Option<String>,
    pub quote: Value,
    pub order_id: Option<String>,
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmCheckoutSession {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_method_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutConfirmResult {
    pub status: String,
    pub order_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BoxOfficeTenderType {
    Comp,
    Cash,
    ManualCard,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBoxOfficeOrder {
    pub tender_type: BoxOfficeTenderType,
    pub amount_cents: i64,
    pub items: Vec<CheckoutItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer: Option<Buyer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer_fields: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxOfficeOrderResult {
    pub order: Order,
    pub session_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: String,
    pub event_id: String,
    pub status: String,
    pub currency: Option<String>,
    pub total_cents: Option<i64>,
    pub sales_channel: Option<String>,
    pub tender_type: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRefund {
    pub order_id: String,
    pub amount_cents: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub type JsonObject = Map<String, Value>;

pub struct CheckoutResource<'a> {
    client: &'a TixkitClient,
}

impl CheckoutResource<'_> {
    pub async fn create(
        &self,
        input: CreateCheckoutSession,
        idempotency_key: impl Into<String>,
    ) -> Result<CheckoutSession, TixkitError> {
        self.client
            .request(
                reqwest::Method::POST,
                "/checkout/sessions",
                RequestOptions::body(input).idempotency_key(Some(idempotency_key.into())),
            )
            .await
    }

    pub async fn get(
        &self,
        session_id: &str,
        client_token: Option<&str>,
    ) -> Result<CheckoutSession, TixkitError> {
        let options: RequestOptions<()> = match client_token {
            Some(token) => RequestOptions::default().header("X-Checkout-Session-Token", token),
            None => RequestOptions::default(),
        };
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/checkout/sessions/{session_id}"),
                options,
            )
            .await
    }

    pub async fn confirm(
        &self,
        session_id: &str,
        input: ConfirmCheckoutSession,
        client_token: &str,
        idempotency_key: impl Into<String>,
    ) -> Result<CheckoutConfirmResult, TixkitError> {
        self.client
            .request(
                reqwest::Method::POST,
                &format!("/checkout/sessions/{session_id}/confirm"),
                RequestOptions::body(input)
                    .idempotency_key(Some(idempotency_key.into()))
                    .header("X-Checkout-Session-Token", client_token),
            )
            .await
    }

    pub async fn create_box_office_order(
        &self,
        event_id: &str,
        input: CreateBoxOfficeOrder,
        idempotency_key: impl Into<String>,
    ) -> Result<BoxOfficeOrderResult, TixkitError> {
        self.client
            .request(
                reqwest::Method::POST,
                &format!("/events/{event_id}/box-office/orders"),
                RequestOptions::body(input).idempotency_key(Some(idempotency_key.into())),
            )
            .await
    }
}

pub struct EventResource<'a> {
    client: &'a TixkitClient,
}

pub struct PublicResource<'a> {
    client: &'a TixkitClient,
}

impl PublicResource<'_> {
    pub async fn get_event(&self, event_id: &str) -> Result<Event, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/public/events/{event_id}"),
                RequestOptions::<()>::default(),
            )
            .await
    }

    pub async fn get_event_page(
        &self,
        event_id: &str,
        params: PublicEventPageParams,
    ) -> Result<PublicContentPage, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/public/events/{event_id}/page"),
                RequestOptions::<()>::query(params.to_query()),
            )
            .await
    }

    pub async fn get_content_page(
        &self,
        event_id: &str,
        params: PublicEventPageParams,
    ) -> Result<PublicContentPage, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/public/events/{event_id}/content-page"),
                RequestOptions::<()>::query(params.to_query()),
            )
            .await
    }

    pub async fn get_event_page_by_slug(
        &self,
        slug: &str,
        params: PublicEventPageBySlugParams,
    ) -> Result<PublicContentPage, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/public/events/by-slug/{slug}/page"),
                RequestOptions::<()>::query(params.to_query()),
            )
            .await
    }

    pub async fn get_event_discovery_card(
        &self,
        event_id: &str,
        params: PublicEventPageParams,
    ) -> Result<PublicEventDiscoveryCard, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/public/events/{event_id}/discovery-card"),
                RequestOptions::<()>::query(params.to_query()),
            )
            .await
    }
}

impl EventResource<'_> {
    pub async fn list(&self, params: PageParams) -> Result<Page<Event>, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                "/events",
                RequestOptions::<()>::query(params.to_query()),
            )
            .await
    }

    pub fn iter(&self, params: PageParams) -> BoxStreamResult<Event> {
        let client = self.client.clone();
        let state = EventPageState {
            params: Some(params),
            buffer: VecDeque::new(),
        };
        Box::pin(stream::unfold(state, move |mut state| {
            let client = client.clone();
            async move {
                loop {
                    if let Some(event) = state.buffer.pop_front() {
                        return Some((Ok(event), state));
                    }
                    let params = state.params.take()?;
                    match client
                        .request::<Page<Event>, ()>(
                            reqwest::Method::GET,
                            "/events",
                            RequestOptions::<()>::query(params.to_query()),
                        )
                        .await
                    {
                        Ok(page) => {
                            state.params = page.next_cursor.clone().map(|cursor| PageParams {
                                cursor: Some(cursor),
                                limit: params.limit,
                            });
                            state.buffer = page.items.into();
                        }
                        Err(error) => {
                            return Some((
                                Err(error),
                                EventPageState {
                                    params: None,
                                    buffer: VecDeque::new(),
                                },
                            ));
                        }
                    }
                }
            }
        }))
    }

    pub async fn get(&self, event_id: &str) -> Result<Event, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/events/{event_id}"),
                RequestOptions::<()>::default(),
            )
            .await
    }

    pub async fn create(&self, input: Value) -> Result<Event, TixkitError> {
        self.client
            .request(
                reqwest::Method::POST,
                "/events",
                RequestOptions::body(input),
            )
            .await
    }
}

struct EventPageState {
    params: Option<PageParams>,
    buffer: VecDeque<Event>,
}

macro_rules! json_resource {
    ($name:ident, $path:literal) => {
        pub struct $name<'a> {
            client: &'a TixkitClient,
        }

        impl $name<'_> {
            pub async fn list(&self, params: PageParams) -> Result<Page<Value>, TixkitError> {
                self.client
                    .request(
                        reqwest::Method::GET,
                        $path,
                        RequestOptions::<()>::query(params.to_query()),
                    )
                    .await
            }

            pub async fn get(&self, id: &str) -> Result<Value, TixkitError> {
                self.client
                    .request(
                        reqwest::Method::GET,
                        &format!("{}/{}", $path, id),
                        RequestOptions::<()>::default(),
                    )
                    .await
            }

            pub async fn create(&self, input: Value) -> Result<Value, TixkitError> {
                self.client
                    .request(reqwest::Method::POST, $path, RequestOptions::body(input))
                    .await
            }

            pub async fn update(&self, id: &str, input: Value) -> Result<Value, TixkitError> {
                self.client
                    .request(
                        reqwest::Method::PATCH,
                        &format!("{}/{}", $path, id),
                        RequestOptions::body(input),
                    )
                    .await
            }
        }
    };
}

json_resource!(TicketTypeResource, "/ticket-types");
json_resource!(RefundResource, "/refunds");
json_resource!(AttendeeResource, "/attendees");
json_resource!(QuestionResource, "/questions");
json_resource!(WaitlistResource, "/waitlist");
json_resource!(ExportResource, "/exports");
json_resource!(WebhookEndpointResource, "/webhook-endpoints");
json_resource!(ApiKeyResource, "/api-keys");

pub struct OrderResource<'a> {
    client: &'a TixkitClient,
}

impl OrderResource<'_> {
    pub async fn list(&self, params: PageParams) -> Result<Page<Order>, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                "/orders",
                RequestOptions::<()>::query(params.to_query()),
            )
            .await
    }

    pub async fn get(&self, order_id: &str) -> Result<Order, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/orders/{order_id}"),
                RequestOptions::<()>::default(),
            )
            .await
    }
}

pub struct CheckInResource<'a> {
    client: &'a TixkitClient,
}

impl CheckInResource<'_> {
    pub async fn scan(
        &self,
        input: Value,
        idempotency_key: impl Into<String>,
    ) -> Result<Value, TixkitError> {
        self.client
            .request(
                reqwest::Method::POST,
                "/check-ins",
                RequestOptions::body(input).idempotency_key(Some(idempotency_key.into())),
            )
            .await
    }

    pub async fn sync(
        &self,
        input: Value,
        idempotency_key: impl Into<String>,
    ) -> Result<Value, TixkitError> {
        self.client
            .request(
                reqwest::Method::POST,
                "/check-ins/sync",
                RequestOptions::body(input).idempotency_key(Some(idempotency_key.into())),
            )
            .await
    }
}

pub struct ReportResource<'a> {
    client: &'a TixkitClient,
}

impl ReportResource<'_> {
    pub async fn sales(&self, event_id: &str) -> Result<Value, TixkitError> {
        self.client
            .request(
                reqwest::Method::GET,
                &format!("/events/{event_id}/reports/sales"),
                RequestOptions::<()>::default(),
            )
            .await
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct WebhookEvent {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub data: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

pub fn verify_tixkit_webhook(
    raw_body: &[u8],
    signature: &str,
    secret: &str,
) -> Result<WebhookEvent, TixkitError> {
    verify_tixkit_webhook_signature(raw_body, signature, secret)?;
    serde_json::from_slice(raw_body).map_err(TixkitError::decode)
}

pub fn verify_tixkit_webhook_signature(
    raw_body: &[u8],
    signature: &str,
    secret: &str,
) -> Result<(), TixkitError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            TixkitError::WebhookSignature("system clock is before Unix epoch".to_string())
        })?
        .as_secs() as i64;
    verify_tixkit_webhook_signature_at(raw_body, signature, secret, now, 300)
}

pub fn verify_tixkit_webhook_signature_at(
    raw_body: &[u8],
    signature: &str,
    secret: &str,
    now_epoch_seconds: i64,
    tolerance_seconds: i64,
) -> Result<(), TixkitError> {
    let (timestamp, provided) = parse_webhook_signature(signature)?;
    if tolerance_seconds > 0 && (now_epoch_seconds - timestamp).abs() > tolerance_seconds {
        return Err(TixkitError::WebhookSignature(
            "webhook signature timestamp is outside tolerance".to_string(),
        ));
    }
    let provided = hex::decode(provided).map_err(|_| {
        TixkitError::WebhookSignature("signature v1 value must be hexadecimal".to_string())
    })?;
    let expected = tixkit_webhook_signature(raw_body, secret, timestamp)?;
    let expected = hex::decode(expected).map_err(|_| {
        TixkitError::WebhookSignature("computed signature was not hexadecimal".to_string())
    })?;

    if constant_time_eq(&expected, &provided) {
        Ok(())
    } else {
        Err(TixkitError::WebhookSignature(
            "invalid webhook signature".to_string(),
        ))
    }
}

pub fn tixkit_webhook_signature(
    raw_body: &[u8],
    secret: &str,
    timestamp: i64,
) -> Result<String, TixkitError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| TixkitError::WebhookSignature("invalid webhook secret".to_string()))?;
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(raw_body);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

pub fn tixkit_webhook_signature_header(
    raw_body: &[u8],
    secret: &str,
    timestamp: i64,
) -> Result<String, TixkitError> {
    Ok(format!(
        "t={timestamp},v1={}",
        tixkit_webhook_signature(raw_body, secret, timestamp)?
    ))
}

fn parse_webhook_signature(signature: &str) -> Result<(i64, &str), TixkitError> {
    let mut timestamp = None;
    let mut v1 = None;
    for part in signature.split(',') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        match key {
            "t" => {
                timestamp = Some(value.parse::<i64>().map_err(|_| {
                    TixkitError::WebhookSignature("signature timestamp is invalid".to_string())
                })?);
            }
            "v1" => v1 = Some(value),
            _ => {}
        }
    }
    let timestamp = timestamp
        .ok_or_else(|| TixkitError::WebhookSignature("signature is missing t".to_string()))?;
    let v1 =
        v1.ok_or_else(|| TixkitError::WebhookSignature("signature is missing v1".to_string()))?;
    Ok((timestamp, v1))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (left, right) in a.iter().zip(b.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client(server: &MockServer) -> TixkitClient {
        TixkitClient::builder()
            .api_key("tk_test_123")
            .api_base_url(server.uri())
            .max_retries(0)
            .build()
            .expect("client")
    }

    #[tokio::test]
    async fn builds_checkout_request_with_version_auth_and_idempotency_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/checkout/sessions"))
            .and(header("authorization", "Bearer tk_test_123"))
            .and(header("x-tixkit-version", TIXKIT_API_VERSION))
            .and(header("idempotency-key", "idem_checkout_1"))
            .and(body_json(json!({
                "eventId": "evt_1",
                "items": [{"ticketTypeId": "tt_1", "quantity": 1}],
                "buyer": {"email": "buyer@example.com"}
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "id": "cs_1",
                "eventId": "evt_1",
                "status": "open",
                "currency": "USD",
                "quote": {},
                "expiresAt": "2026-01-01T00:00:00.000Z"
            })))
            .mount(&server)
            .await;

        let result = client(&server)
            .await
            .checkout()
            .create(
                CreateCheckoutSession {
                    event_id: "evt_1".to_string(),
                    items: vec![CheckoutItem {
                        ticket_type_id: Some("tt_1".to_string()),
                        occurrence_id: None,
                        product_id: None,
                        quantity: 1,
                        unit_amount_cents: None,
                        attendee_fields: None,
                    }],
                    buyer: Some(Buyer {
                        email: Some("buyer@example.com".to_string()),
                        first_name: None,
                        last_name: None,
                        phone: None,
                    }),
                    buyer_fields: None,
                    discount_code: None,
                    affiliate_code: None,
                    tracking_id: None,
                    success_url: None,
                    cancel_url: None,
                    access_code: None,
                    waitlist_claim_token: None,
                },
                "idem_checkout_1",
            )
            .await
            .expect("checkout session");

        assert_eq!(result.id, "cs_1");
    }

    #[tokio::test]
    async fn builds_public_event_page_routes() {
        let server = MockServer::start().await;
        let page_body = json!({
            "document": {
                "eventId": "evt_1",
                "channel": "event_page",
                "key": "main",
                "name": "Main event page",
                "locale": "en",
                "updatedAt": "2026-06-01T00:00:00.000Z"
            },
            "version": {
                "versionNumber": 3,
                "renderedHtml": "<main class=\"tixkit-event-page\">All Access</main>",
                "renderedText": "All Access",
                "publishedAt": "2026-06-02T00:00:00.000Z"
            },
            "page": {
                "html": "<main>All Access</main>",
                "text": "All Access",
                "headless": [{"type": "hero", "id": "hero", "title": "All Access"}],
                "discovery": {
                    "title": "All Access",
                    "summary": "Chicago",
                    "tags": ["music"],
                    "venueName": "The Salt Shed"
                }
            }
        });
        Mock::given(method("GET"))
            .and(path("/v1/public/events/evt_1/content-page"))
            .and(query_param("locale", "en"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page_body.clone()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/public/events/evt_1/page"))
            .and(query_param("locale", "en"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page_body.clone()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/public/events/by-slug/all-access/page"))
            .and(query_param("host", "events.example.com"))
            .and(query_param("locale", "en"))
            .respond_with(ResponseTemplate::new(200).set_body_json(page_body))
            .mount(&server)
            .await;

        let tixkit = client(&server).await;
        let content_page = tixkit
            .public()
            .get_content_page(
                "evt_1",
                PublicEventPageParams {
                    locale: Some("en".to_string()),
                },
            )
            .await
            .expect("content page");
        assert_eq!(content_page.document.event_id, "evt_1");
        assert_eq!(content_page.page.discovery.title, "All Access");

        tixkit
            .public()
            .get_event_page(
                "evt_1",
                PublicEventPageParams {
                    locale: Some("en".to_string()),
                },
            )
            .await
            .expect("event page");

        tixkit
            .public()
            .get_event_page_by_slug(
                "all-access",
                PublicEventPageBySlugParams {
                    host: "events.example.com".to_string(),
                    locale: Some("en".to_string()),
                },
            )
            .await
            .expect("slug page");
    }

    #[tokio::test]
    async fn builds_public_event_discovery_card_route() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/public/events/evt_1/discovery-card"))
            .and(query_param("locale", "en"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "title": "All Access",
                "summary": "Chicago",
                "tags": ["music"],
                "venueName": "The Salt Shed"
            })))
            .mount(&server)
            .await;

        let card = client(&server)
            .await
            .public()
            .get_event_discovery_card(
                "evt_1",
                PublicEventPageParams {
                    locale: Some("en".to_string()),
                },
            )
            .await
            .expect("discovery card");

        assert_eq!(card.title, "All Access");
        assert_eq!(card.venue_name.as_deref(), Some("The Salt Shed"));
    }

    #[tokio::test]
    async fn retries_idempotent_server_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/checkout/sessions"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({
                "error": {"code": "TEMPORARY", "message": "try again", "requestId": "req_1"}
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/checkout/sessions"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "id": "cs_retry",
                "eventId": "evt_1",
                "status": "open",
                "currency": "USD",
                "quote": {}
            })))
            .mount(&server)
            .await;

        let result = TixkitClient::builder()
            .api_base_url(server.uri())
            .max_retries(1)
            .retry_backoff(Duration::from_millis(1))
            .build()
            .expect("client")
            .checkout()
            .create(empty_checkout(), "idem_retry")
            .await
            .expect("retry success");

        assert_eq!(result.id, "cs_retry");
    }

    #[tokio::test]
    async fn does_not_retry_non_idempotent_post_server_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/events"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({
                "error": {"code": "TEMPORARY", "message": "try again", "requestId": "req_create"}
            })))
            .mount(&server)
            .await;

        let error = TixkitClient::builder()
            .api_base_url(server.uri())
            .max_retries(3)
            .retry_backoff(Duration::from_millis(1))
            .build()
            .expect("client")
            .events()
            .create(json!({"title": "Box Office"}))
            .await
            .expect_err("non-idempotent create fails once");

        match error {
            TixkitError::Api(source) => {
                assert_eq!(source.status, StatusCode::SERVICE_UNAVAILABLE);
                assert_eq!(source.code, "TEMPORARY");
                assert_eq!(source.request_id, "req_create");
            }
            other => panic!("unexpected error: {other:?}"),
        }
        let create_attempts = server
            .received_requests()
            .await
            .expect("recorded requests")
            .iter()
            .filter(|request| request.method == "POST" && request.url.path() == "/v1/events")
            .count();
        assert_eq!(create_attempts, 1);
    }

    #[tokio::test]
    async fn returns_last_retryable_api_error_after_retry_budget_is_exhausted() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/events/evt_retry"))
            .respond_with(ResponseTemplate::new(503).set_body_json(json!({
                "error": {"code": "TEMPORARY", "message": "first failure", "requestId": "req_503"}
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/events/evt_retry"))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "error": {"code": "RATE_LIMITED", "message": "slow down", "requestId": "req_429"}
            })))
            .mount(&server)
            .await;

        let error = TixkitClient::builder()
            .api_base_url(server.uri())
            .max_retries(1)
            .retry_backoff(Duration::from_millis(1))
            .build()
            .expect("client")
            .events()
            .get("evt_retry")
            .await
            .expect_err("retry budget exhausted");

        match error {
            TixkitError::Api(source) => {
                assert_eq!(source.status, StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(source.code, "RATE_LIMITED");
                assert_eq!(source.request_id, "req_429");
            }
            other => panic!("unexpected error: {other:?}"),
        }
        let attempts = server
            .received_requests()
            .await
            .expect("recorded requests")
            .iter()
            .filter(|request| {
                request.method == "GET" && request.url.path() == "/v1/events/evt_retry"
            })
            .count();
        assert_eq!(attempts, 2);
    }

    #[tokio::test]
    async fn maps_api_errors_without_retrying_client_errors() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/events/missing"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "error": {
                    "code": "NOT_FOUND",
                    "message": "Event not found",
                    "requestId": "req_missing",
                    "details": {"resource": "event"}
                }
            })))
            .mount(&server)
            .await;

        let error = client(&server)
            .await
            .events()
            .get("missing")
            .await
            .expect_err("404 error");

        match error {
            TixkitError::Api(source) => {
                assert_eq!(source.status, StatusCode::NOT_FOUND);
                assert_eq!(source.code, "NOT_FOUND");
                assert_eq!(source.request_id, "req_missing");
                assert_eq!(source.details["resource"], "event");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn paginates_events_as_stream() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/events"))
            .and(query_param("limit", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{"id": "evt_1", "title": "One"}],
                "nextCursor": "cursor_2"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/events"))
            .and(query_param("cursor", "cursor_2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{"id": "evt_2", "title": "Two"}],
                "nextCursor": null
            })))
            .mount(&server)
            .await;

        let events = client(&server)
            .await
            .events()
            .iter(PageParams {
                cursor: None,
                limit: Some(1),
            })
            .try_collect::<Vec<_>>()
            .await
            .expect("events");

        assert_eq!(
            events.iter().map(|event| &event.id).collect::<Vec<_>>(),
            vec!["evt_1", "evt_2"]
        );
    }

    #[tokio::test]
    async fn streams_large_event_pagination_without_dropping_or_looping() {
        let server = MockServer::start().await;
        let page_count = 25;
        for page in 0..page_count {
            let event_id = format!("evt_{page:02}");
            let next_cursor = if page + 1 == page_count {
                Value::Null
            } else {
                json!(format!("cursor_{:02}", page + 1))
            };
            let mut mock = Mock::given(method("GET")).and(path("/v1/events"));
            if page == 0 {
                mock = mock.and(query_param("limit", "1"));
            } else {
                mock = mock.and(query_param("cursor", format!("cursor_{page:02}")));
            }
            mock.respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{"id": event_id, "title": format!("Event {page:02}")}],
                "nextCursor": next_cursor
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        }

        let events = client(&server)
            .await
            .events()
            .iter(PageParams {
                cursor: None,
                limit: Some(1),
            })
            .try_collect::<Vec<_>>()
            .await
            .expect("events");

        assert_eq!(events.len(), page_count);
        assert_eq!(
            events.first().map(|event| event.id.as_str()),
            Some("evt_00")
        );
        assert_eq!(events.last().map(|event| event.id.as_str()), Some("evt_24"));
        let requests = server.received_requests().await.expect("recorded requests");
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == "GET" && request.url.path() == "/v1/events")
                .count(),
            page_count
        );
    }

    #[tokio::test]
    async fn sends_box_office_order_idempotency_key_only_as_header() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/events/evt_1/box-office/orders"))
            .and(header("idempotency-key", "idem_box_1"))
            .and(body_json(json!({
                "tenderType": "manual_card",
                "amountCents": 2500,
                "items": [{"ticketTypeId": "tt_1", "quantity": 1}]
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "sessionId": "cs_box",
                "status": "completed",
                "order": {
                    "id": "ord_1",
                    "eventId": "evt_1",
                    "status": "paid",
                    "currency": "USD",
                    "totalCents": 2500,
                    "salesChannel": "box_office",
                    "tenderType": "manual_card"
                }
            })))
            .mount(&server)
            .await;

        let result = client(&server)
            .await
            .checkout()
            .create_box_office_order(
                "evt_1",
                CreateBoxOfficeOrder {
                    tender_type: BoxOfficeTenderType::ManualCard,
                    amount_cents: 2500,
                    items: vec![CheckoutItem {
                        ticket_type_id: Some("tt_1".to_string()),
                        occurrence_id: None,
                        product_id: None,
                        quantity: 1,
                        unit_amount_cents: None,
                        attendee_fields: None,
                    }],
                    buyer: None,
                    buyer_fields: None,
                    notes: None,
                },
                "idem_box_1",
            )
            .await
            .expect("box office order");

        assert_eq!(result.order.sales_channel.as_deref(), Some("box_office"));
        assert_eq!(result.order.tender_type.as_deref(), Some("manual_card"));
    }

    #[test]
    fn verifies_tixkit_webhook_signature_vectors() {
        let raw = br#"{"id":"whe_123","type":"order.paid"}"#;
        let secret = "whsec_test";
        let timestamp = 1_775_000_000;
        let signature = tixkit_webhook_signature_header(raw, secret, timestamp).expect("signature");

        assert_eq!(
            tixkit_webhook_signature(raw, secret, timestamp).expect("signature"),
            "99978ceb7afad605bed97d2fd961c24769d7686ac906cecac1db3b22649220a8"
        );
        verify_tixkit_webhook_signature_at(raw, &signature, secret, timestamp + 10, 300)
            .expect("signature verified");
        let event = serde_json::from_slice::<WebhookEvent>(raw).expect("event");

        assert_eq!(event.id.as_deref(), Some("whe_123"));
        assert_eq!(event.event_type, "order.paid");
        assert!(
            verify_tixkit_webhook_signature_at(raw, &signature, "wrong", timestamp, 300).is_err()
        );
        assert!(
            verify_tixkit_webhook_signature_at(raw, &signature, secret, timestamp + 600, 300)
                .is_err()
        );
        assert!(
            verify_tixkit_webhook_signature_at(raw, "sha256=001122", secret, timestamp, 300)
                .is_err()
        );
    }

    #[test]
    fn rejects_malformed_tixkit_webhook_signature_headers() {
        let raw = br#"{"id":"whe_123","type":"order.paid"}"#;
        let secret = "whsec_test";
        let timestamp = 1_775_000_000;
        let signature = tixkit_webhook_signature(raw, secret, timestamp).expect("signature");
        let invalid_headers = [
            format!("t=not-a-number,v1={signature}"),
            format!("t={timestamp},v1=not-hex"),
            format!("t={timestamp}"),
            format!("v1={signature}"),
            format!("t={timestamp},v1={}", &signature[..signature.len() - 2]),
        ];

        for header in invalid_headers {
            assert!(
                verify_tixkit_webhook_signature_at(raw, &header, secret, timestamp, 300).is_err(),
                "header should fail verification: {header}"
            );
        }
    }

    fn empty_checkout() -> CreateCheckoutSession {
        CreateCheckoutSession {
            event_id: "evt_1".to_string(),
            items: vec![CheckoutItem {
                ticket_type_id: Some("tt_1".to_string()),
                occurrence_id: None,
                product_id: None,
                quantity: 1,
                unit_amount_cents: None,
                attendee_fields: None,
            }],
            buyer: None,
            buyer_fields: None,
            discount_code: None,
            affiliate_code: None,
            tracking_id: None,
            success_url: None,
            cancel_url: None,
            access_code: None,
            waitlist_claim_token: None,
        }
    }
}

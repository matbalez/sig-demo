// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

use goose_provider_types::errors::ProviderError;

#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct Failure {
    pub code: &'static str,
    pub message: &'static str,
    pub http_status: Option<u16>,
    pub reason_code: Option<&'static str>,
}

impl Failure {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            http_status: None,
            reason_code: None,
        }
    }
    pub const fn internal() -> Self {
        Self::new("generic", "Sig could not complete the request. Try again.")
    }
    pub const fn empty() -> Self {
        Self::new(
            "application-error",
            "Sig returned an empty response. Try again.",
        )
    }
    pub const fn cancelled() -> Self {
        Self::new("application-error", "Sig's request was cancelled.")
    }
    pub const fn timeout() -> Self {
        Self::new("timeout", "Sig's request timed out. Try again.")
    }
    pub const fn tool_invalid() -> Self {
        Self::new(
            "tool-arguments-invalid",
            "The inference provider returned an invalid web search request. Please try again.",
        )
    }
    pub const fn tool_incomplete() -> Self {
        Self::new(
            "tool-arguments-incomplete",
            "The inference provider returned an invalid web search request. Please try again.",
        )
    }
    pub const fn output_limit() -> Self {
        Self::new(
            "output-token-limit",
            "Sig's response exceeded the output limit.",
        )
    }
    pub const fn search_limit() -> Self {
        Self::new(
            "application-error",
            "Sig reached its web search limit. Please try a more specific question.",
        )
    }

    pub fn from_provider(error: &ProviderError) -> Self {
        let mut failure = Self::classify_provider(error);
        failure.http_status = provider_http_status(error);
        failure.reason_code = mesh_reason(error, failure.http_status);
        failure
    }

    fn classify_provider(error: &ProviderError) -> Self {
        match error {
            ProviderError::Authentication(_) => {
                return Self::new("authentication", "Sig's API credential was rejected.")
            }
            ProviderError::ContextLengthExceeded(_) => {
                return Self::new(
                    "context-length",
                    "The submitted message is too long for this model.",
                )
            }
            ProviderError::RateLimitExceeded { .. } => {
                return Self::new("rate-limited", "Sig is busy. Try again shortly.")
            }
            ProviderError::CreditsExhausted { .. } => {
                return Self::new(
                    "payment-required",
                    "The inference provider requires payment or rejected payment authorization. Check Wallet and try again.",
                )
            }
            ProviderError::ServerError(_) => {
                return Self::new(
                    "server-error",
                    "The inference provider reported a server error. Please try again.",
                )
            }
            ProviderError::EndpointNotFound(_) => {
                return Self::new(
                    "endpoint-not-found",
                    "The inference endpoint could not be found.",
                )
            }
            ProviderError::RequestFailed(details) => {
                return match provider_http_status(error) {
                    Some(401 | 403) => {
                        Self::new("authentication", "Sig's API credential was rejected.")
                    }
                    Some(402) => Self::new(
                        "payment-required",
                        "The inference provider requires payment or rejected payment authorization. Check Wallet and try again.",
                    ),
                    Some(404) => Self::new(
                        "endpoint-not-found",
                        "The inference endpoint could not be found.",
                    ),
                    Some(408) => Self::timeout(),
                    Some(413) => Self::new(
                        "context-length",
                        "The submitted message is too long for this model.",
                    ),
                    Some(429) => Self::new("rate-limited", "Sig is busy. Try again shortly."),
                    Some(500..=599) => Self::new(
                        "server-error",
                        "The inference provider reported a server error. Please try again.",
                    ),
                    _ if is_model_missing(details) => Self::new(
                        "model-unavailable",
                        "The configured Sig model is unavailable for this API key.",
                    ),
                    _ => Self::new(
                        "request-rejected",
                        "The inference provider rejected the request.",
                    ),
                }
            }
            ProviderError::Refusal { .. } | ProviderError::InvalidValue(_) => {
                return Self::new(
                    "request-rejected",
                    "The inference provider rejected the request.",
                )
            }
            ProviderError::ExecutionError(message)
                if matches!(
                    message.as_str(),
                    "Sig returned an invalid web search request. Please try again."
                        | "Sig returned conflicting web search requests. Please try again."
                        | "Sig returned too many web search requests."
                ) =>
            {
                return Self::tool_invalid()
            }
            ProviderError::ExecutionError(message)
                if message
                    == "Sig requested an unavailable tool. Only Brave web search is supported." =>
            {
                return Self::new(
                    "application-error",
                    "Sig requested an unavailable tool. Only Brave web search is supported.",
                )
            }
            _ => {}
        }
        let details = error.to_string();
        let normalized = details.to_lowercase();
        if details
            .starts_with("Network error: Stream decode error: Failed to parse streaming chunk:")
        {
            Self::new(
                "stream-format-invalid",
                "The inference provider returned an unreadable response. Please try again.",
            )
        } else if details
            .starts_with("Network error: Stream decode error: error decoding response body")
        {
            Self::new(
                "stream-interrupted",
                "The inference connection closed before Sig finished. Please try again.",
            )
        } else if matches!(error, ProviderError::NetworkError(_))
            && (normalized.contains("timed out") || normalized.contains("timeout"))
        {
            Self::timeout()
        } else if details.starts_with("Network error: Could not connect to ") {
            Self::new(
                "network-connect",
                "Sig could not connect to the inference provider. Try again.",
            )
        } else if details.starts_with("Network error:") {
            Self::new(
                "network-error",
                "Sig's connection to the inference provider failed. Try again.",
            )
        } else {
            Self::internal()
        }
    }
}

fn is_model_missing(details: &str) -> bool {
    // Classification only; no provider text is retained in the returned error.
    let normalized = details.to_ascii_lowercase();
    normalized.contains("model_not_found")
        || (normalized.contains("model") && normalized.contains("does not exist"))
}

fn status_before(details: &str, separator: &str) -> Option<u16> {
    let (status, _) = details.split_once(separator)?;
    let digits = status.get(..3)?;
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let code = digits.parse::<u16>().ok()?;
    // Pin to the actual StatusCode Display used by GDK's HTTP formatter, not
    // numbers occurring elsewhere in an untrusted provider message.
    let known = reqwest::StatusCode::from_u16(code).ok()?;
    ((400..=599).contains(&code) && known.to_string() == status).then_some(code)
}

fn provider_http_status(error: &ProviderError) -> Option<u16> {
    match error {
        ProviderError::Authentication(details) => {
            let rest = details.strip_prefix("Authentication failed for ")?;
            let (_, status) = rest.split_once(". Status: ")?;
            status_before(status, ". Response: ").filter(|status| matches!(status, 401 | 403))
        }
        ProviderError::ServerError(details) => {
            let rest = details.strip_prefix("Server error (")?;
            status_before(rest, ") at ").filter(|status| *status >= 500)
        }
        ProviderError::RequestFailed(details) => {
            if details.starts_with("Resource not found (404) at ") {
                Some(404)
            } else if details.starts_with("Bad request (400): ") {
                Some(400)
            } else if let Some(rest) = details.strip_prefix("Request failed with status ") {
                status_before(rest, " at ")
            } else if let Some(rest) = details.strip_prefix("HTTP status error (status: ") {
                // GDK's sanitized reqwest conversion has either a URL field or
                // just the status. Never copy that URL into our diagnostics.
                status_before(rest, ", ").or_else(|| status_before(rest, ")"))
            } else {
                None
            }
        }
        // GDK drops HTTP status text for typed payment and rate-limit errors,
        // and conflates HTTP 400 and 413 into ContextLengthExceeded. It also
        // uses EndpointNotFound for some non-HTTP model payload failures, and
        // ServerError for SSE failures after HTTP 200. Do not invent statuses.
        _ => None,
    }
}

fn without_request_id(details: &str) -> &str {
    details
        .rsplit_once(" (provider request id: ")
        .filter(|(_, suffix)| suffix.ends_with(')'))
        .map_or(details, |(message, _)| message)
}

fn routes_exhausted(message: &str) -> bool {
    let Some(rest) = message.strip_prefix("all ") else {
        return false;
    };
    let Some((count, rest)) = rest.split_once(' ') else {
        return false;
    };
    !count.is_empty()
        && count.bytes().all(|byte| byte.is_ascii_digit())
        && ((rest.starts_with("tunnel(s) to hosts for ")
            && rest.ends_with(" failed (mesh request)"))
            || (rest.starts_with("target(s) for model '") && rest.ends_with("' failed")))
}

fn mesh_reason(error: &ProviderError, status: Option<u16>) -> Option<&'static str> {
    if let ProviderError::CreditsExhausted { details, .. } = error {
        return match without_request_id(details) {
            "paid providers are unavailable under the current payment policy, local payee blocklist, wallet balance or daily budget" => Some("payment-route-denied"),
            "could not start paid inference" => Some("paid-start-failed"),
            "payment was not authorized" => Some("payment-not-authorized"),
            "paid inference interrupted; settlement remains recoverable" => Some("paid-interrupted"),
            "only locally originated requests may spend this wallet" => Some("payment-origin-denied"),
            "this provider requires the Lightning payment protocol" | "payment-capable peer required" => Some("payment-protocol-required"),
            "seller payment state unavailable" => Some("seller-payment-unavailable"),
            "invalid request payment intent" => Some("payment-intent-invalid"),
            _ => None,
        };
    }
    if let (ProviderError::ServerError(details), Some(503)) = (error, status) {
        let (_, rest) = details.split_once(") at ")?;
        let (_, body) = rest.split_once(": ")?;
        let body = without_request_id(body);
        return match body {
            "no peers serving any model (mesh empty or gossip stale)" => {
                Some("mesh-no-serving-peer")
            }
            body if routes_exhausted(body) => Some("mesh-routes-exhausted"),
            _ => None,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use goose_providers::http_status::map_http_error;
    use serde_json::json;

    fn http(status: u16, message: &str) -> Failure {
        Failure::from_provider(&map_http_error(
            reqwest::StatusCode::from_u16(status).unwrap(),
            Some(json!({"error":{"message":message}})),
            "https://example.test/private-endpoint?api_key=private-key",
            Some("private-request-id"),
        ))
    }

    #[test]
    fn payment_server_and_endpoint_failures_remain_distinct() {
        let payment = http(402, "payment was not authorized");
        assert_eq!(payment.code, "payment-required");
        assert_eq!(payment.http_status, None);
        assert_eq!(payment.reason_code, Some("payment-not-authorized"));

        let server = http(
            503,
            "no peers serving any model (mesh empty or gossip stale)",
        );
        assert_eq!(server.code, "server-error");
        assert_eq!(server.http_status, Some(503));
        assert_eq!(server.reason_code, Some("mesh-no-serving-peer"));

        let endpoint = http(404, "not found");
        assert_eq!(endpoint.code, "endpoint-not-found");
        assert_eq!(endpoint.http_status, Some(404));
        assert_eq!(http(422, "bad shape").code, "request-rejected");
        assert_eq!(http(422, "bad shape").http_status, Some(422));
    }

    #[test]
    fn context_authentication_and_rate_limits_do_not_collapse_to_unavailable() {
        for status in [400, 413] {
            let context = http(status, "context length exceeded");
            assert_eq!(context.code, "context-length");
            // The published GDK drops the distinction between these two HTTP
            // statuses before returning its typed context error.
            assert_eq!(context.http_status, None);
        }
        let explicit = Failure::from_provider(&ProviderError::RequestFailed(
            "HTTP status error (status: 413 Payload Too Large, url: https://example.test/private)"
                .into(),
        ));
        assert_eq!(explicit.code, "context-length");
        assert_eq!(explicit.http_status, Some(413));
        for status in [401, 403] {
            let authentication = http(status, "untrusted secret");
            assert_eq!(authentication.code, "authentication");
            assert_eq!(authentication.http_status, Some(status));
        }
        let limit = http(429, "too busy");
        assert_eq!(limit.code, "rate-limited");
        assert_eq!(limit.http_status, None);
    }

    #[tokio::test]
    async fn sse_code_500_is_not_invented_as_an_http_status() {
        use futures::StreamExt;
        use goose_provider_types::formats::openai::response_to_streaming_message;

        let source = futures::stream::iter(vec![Ok::<_, anyhow::Error>(
            r#"data: {"error":{"message":"private SSE body","code":500}}"#.to_owned(),
        )]);
        let stream = response_to_streaming_message(source);
        futures::pin_mut!(stream);
        let error = stream.next().await.unwrap().unwrap_err();
        let provider = error.downcast_ref::<ProviderError>().unwrap();
        let failure = Failure::from_provider(provider);
        assert_eq!(failure.code, "server-error");
        assert_eq!(failure.http_status, None);
        assert_eq!(failure.reason_code, None);
        assert!(!format!("{failure:?}").contains("private SSE body"));
    }

    #[test]
    fn remote_payloads_never_become_diagnostics_or_override_typed_errors() {
        let private = "private-key private-prompt https://private.test/secret private-request-id";
        for failure in [
            http(402, private),
            http(503, private),
            http(400, private),
            http(404, private),
            http(401, private),
            Failure::from_provider(&ProviderError::ServerError(format!(
                "body claims HTTP 402 and timeout: {private}"
            ))),
            Failure::from_provider(&ProviderError::ExecutionError(format!(
                "body claims HTTP 503 and timeout: {private}"
            ))),
        ] {
            let exposed = format!("{failure:?} {failure}");
            for secret in [
                "private-key",
                "private-prompt",
                "private.test",
                "private-request-id",
            ] {
                assert!(!exposed.contains(secret));
            }
            assert_eq!(failure.reason_code, None);
        }
        let spoof = Failure::from_provider(&ProviderError::ServerError(
            "prefix Server error (503 Service Unavailable) at https://example.test: nope".into(),
        ));
        assert_eq!(spoof.code, "server-error");
        assert_eq!(spoof.http_status, None);
        let unknown =
            Failure::from_provider(&ProviderError::EndpointNotFound("invalid JSON".into()));
        assert_eq!(unknown.http_status, None);
    }

    #[test]
    fn mesh_reason_codes_use_exact_known_templates_and_strip_private_values() {
        for (message, reason) in [
            (
                "paid providers are unavailable under the current payment policy, local payee blocklist, wallet balance or daily budget",
                "payment-route-denied",
            ),
            ("could not start paid inference", "paid-start-failed"),
            (
                "paid inference interrupted; settlement remains recoverable",
                "paid-interrupted",
            ),
            (
                "only locally originated requests may spend this wallet",
                "payment-origin-denied",
            ),
            (
                "this provider requires the Lightning payment protocol",
                "payment-protocol-required",
            ),
            ("seller payment state unavailable", "seller-payment-unavailable"),
            ("invalid request payment intent", "payment-intent-invalid"),
        ] {
            assert_eq!(http(402, message).reason_code, Some(reason));
        }
        for message in [
            "all 4 tunnel(s) to hosts for Some(\"private-model\") failed (mesh request)",
            "all 2 target(s) for model 'private-model' failed",
        ] {
            let failure = http(503, message);
            assert_eq!(failure.reason_code, Some("mesh-routes-exhausted"));
            assert!(!format!("{failure:?}").contains("private-model"));
        }
        assert_eq!(
            http(402, "insufficient unreserved wallet balance").reason_code,
            None
        );
        assert_eq!(
            http(503, "could not start paid inference").reason_code,
            None
        );
        assert_eq!(
            http(402, "prefix payment was not authorized").reason_code,
            None
        );
    }

    #[test]
    fn transport_and_stream_failures_keep_their_existing_safe_classifications() {
        for (detail, code) in [
            ("Request timed out — check your network connection and try again.", "timeout"),
            ("Could not connect to private.test:1234 — check your network connection and try again.", "network-connect"),
            ("Stream decode error: Failed to parse streaming chunk: private payload", "stream-format-invalid"),
            ("Stream decode error: error decoding response body: private details", "stream-interrupted"),
            ("private other network failure", "network-error"),
        ] {
            let failure = Failure::from_provider(&ProviderError::NetworkError(detail.into()));
            assert_eq!(failure.code, code);
            assert_eq!(failure.http_status, None);
            assert_eq!(failure.reason_code, None);
            assert!(!format!("{failure:?}").contains("private"));
        }
    }
}

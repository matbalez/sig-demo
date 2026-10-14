// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

use goose_provider_types::errors::ProviderError;

#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct Failure {
    pub code: &'static str,
    pub message: &'static str,
}

impl Failure {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
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
            ProviderError::ServerError(_)
            | ProviderError::EndpointNotFound(_)
            | ProviderError::CreditsExhausted { .. } => {
                return Self::new(
                    "provider-unavailable",
                    "Sig's model provider is unavailable.",
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
        } else if normalized.contains("timed out") || normalized.contains("timeout") {
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
        } else if normalized.contains("model_not_found") || normalized.contains("does not exist") {
            Self::new(
                "model-unavailable",
                "The configured Sig model is unavailable for this API key.",
            )
        } else {
            Self::internal()
        }
    }
}

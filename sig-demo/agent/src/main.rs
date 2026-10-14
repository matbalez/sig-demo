// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

//! One submitted message per process. No history, memory, tools, or request logging.
use std::io::{self, Read, Write};
use std::time::Duration;

use goose_sdk::bindings::{
    openai_provider, GooseError, GooseStreamErrorKind, MessageContent, MessageRole,
    ProviderMessage, ProviderModelConfig, StreamChunk,
};
use serde::{Deserialize, Serialize};

const DEFAULT_MODEL: &str = "gpt-6-luna";
const SYSTEM: &str = "You are Sig, a helpful assistant in a private messenger. Answer the submitted message clearly and concisely. You receive only this message and have no chat history, memory, attachments, or tools.";
const MAX_INPUT_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    prompt: String,
    #[serde(default = "default_model")]
    model: String,
}

fn default_model() -> String {
    DEFAULT_MODEL.to_owned()
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event<'a> {
    Text { text: &'a str },
    Done,
    Error { message: &'a str },
}

fn emit(event: Event<'_>) -> Result<(), &'static str> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, &event).map_err(|_| "Could not write the response.")?;
    output
        .write_all(b"\n")
        .map_err(|_| "Could not write the response.")?;
    output.flush().map_err(|_| "Could not write the response.")
}

fn read_request() -> Result<Request, &'static str> {
    let mut input = String::new();
    io::stdin()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_string(&mut input)
        .map_err(|_| "Could not read the submitted message.")?;
    if input.len() as u64 > MAX_INPUT_BYTES {
        return Err("The submitted message is too long.");
    }
    let request: Request = serde_json::from_str(&input).map_err(|_| "Invalid agent request.")?;
    if request.prompt.trim().is_empty() {
        return Err("Enter a message for Sig.");
    }
    if request.model.trim().is_empty() || request.model.len() > 128 {
        return Err("Invalid model name.");
    }
    Ok(request)
}

// Provider details may contain user input or credentials; only expose classified errors.
fn safe_error(error: &GooseError) -> &'static str {
    match error {
        GooseError::RateLimited { .. } => "Sig is busy. Try again shortly.",
        GooseError::OutputTokenLimitExceeded { .. } => "Sig's response exceeded the output limit.",
        GooseError::ContextLengthExceeded { .. } => {
            "The submitted message is too long for this model."
        }
        GooseError::Authentication { .. } => "Sig's API credential was rejected.",
        GooseError::Timeout { .. } => "Sig's request timed out. Try again.",
        GooseError::ProviderUnavailable { .. } => "Sig's model provider is unavailable.",
        GooseError::Generic { details } => {
            let details = details.to_ascii_lowercase();
            if details.contains("model_not_found") || details.contains("does not exist") {
                "The configured Sig model is unavailable for this API key."
            } else {
                "Sig could not complete the request. Try again."
            }
        }
    }
}

fn safe_stream_error(kind: &GooseStreamErrorKind) -> &'static str {
    match kind {
        GooseStreamErrorKind::RateLimited => "Sig is busy. Try again shortly.",
        GooseStreamErrorKind::OutputTokenLimitExceeded => {
            "Sig's response exceeded the output limit."
        }
        GooseStreamErrorKind::ContextLengthExceeded => {
            "The submitted message is too long for this model."
        }
        GooseStreamErrorKind::Authentication => "Sig's API credential was rejected.",
        GooseStreamErrorKind::Timeout => "Sig's request timed out. Try again.",
        GooseStreamErrorKind::ProviderUnavailable => "Sig's model provider is unavailable.",
        GooseStreamErrorKind::Generic => "Sig could not complete the request. Try again.",
    }
}

async fn answer(request: Request) -> Result<(), &'static str> {
    let api_key = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or("Sig's API credential is missing.")?;
    let provider = openai_provider(api_key, None).map_err(|error| safe_error(&error))?;
    let model = ProviderModelConfig {
        model_name: request.model,
        context_limit: None,
        temperature: None,
        max_tokens: Some(2048),
        toolshim: false,
        toolshim_model: None,
        // GDK maps "off" to the model's lowest supported effort (none for gpt-6-luna).
        request_params_json: Some(r#"{"thinking_effort":"off","store":false}"#.to_owned()),
        provider_params_json: None,
        reasoning: None,
        timeout_ms: Some(90_000),
        request_headers: None,
    };
    let messages = vec![ProviderMessage {
        role: MessageRole::User,
        content: vec![MessageContent::Text {
            text: request.prompt,
        }],
    }];
    let stream = provider
        .stream(model, SYSTEM.to_owned(), messages, vec![])
        .await
        .map_err(|error| safe_error(&error))?;
    let mut received_text = false;
    while let Some(chunk) = stream
        .next_chunk()
        .await
        .map_err(|error| safe_error(&error))?
    {
        match chunk {
            StreamChunk::TextChunk { text } => {
                received_text |= !text.trim().is_empty();
                if !text.is_empty() {
                    emit(Event::Text { text: &text })?;
                }
            }
            StreamChunk::ErrorChunk { error } => return Err(safe_stream_error(&error.kind)),
            StreamChunk::ToolChunk { .. } => {
                return Err("Sig returned an unsupported tool request.")
            }
            StreamChunk::EndChunk { .. } => break,
            StreamChunk::ThinkingChunk { .. } | StreamChunk::RedactedThinkingChunk { .. } => {}
        }
    }
    if !received_text {
        return Err("Sig returned an empty response. Try again.");
    }
    emit(Event::Done)
}

#[tokio::main]
async fn main() {
    let result = match read_request() {
        Ok(request) => {
            match tokio::time::timeout(Duration::from_secs(120), answer(request)).await {
                Ok(result) => result,
                Err(_) => Err("Sig's request timed out. Try again."),
            }
        }
        Err(error) => Err(error),
    };
    if let Err(message) = result {
        let _ = emit(Event::Error { message });
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_one_prompt_and_model() {
        let request: Request =
            serde_json::from_str(r#"{"prompt":"hello","model":"gpt-6-luna"}"#).unwrap();
        assert_eq!(request.prompt, "hello");
        assert!(
            serde_json::from_str::<Request>(r#"{"prompt":"hello","history":["secret"]}"#).is_err()
        );
        assert!(
            serde_json::from_str::<Request>(r#"{"prompt":"hello","tools":["shell"]}"#).is_err()
        );
    }

    #[test]
    fn never_exposes_provider_error_details() {
        let error = GooseError::Generic {
            details: "private submitted prompt and api credential".to_owned(),
        };
        assert_eq!(
            safe_error(&error),
            "Sig could not complete the request. Try again."
        );
    }
}

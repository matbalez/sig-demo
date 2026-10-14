// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

//! One submitted message per process. No history, memory, tools, or request logging.
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::time::Duration;

use goose_sdk::bindings::{
    declarative_provider_from_json, openai_provider, GooseError, GooseStreamErrorKind,
    MessageContent, MessageRole, ProviderMessage, ProviderModelConfig, StreamChunk,
};
use serde::{Deserialize, Serialize};

const DEFAULT_CHATGPT_MODEL: &str = "gpt-6-luna";
const SYSTEM: &str = "You are Sig, a helpful assistant in a private messenger. Answer the submitted message clearly and concisely. You receive only this message and have no chat history, memory, attachments, or tools.";
const MAX_INPUT_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    prompt: String,
    model: Option<String>,
    #[serde(default)]
    provider: InferenceProvider,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    #[serde(rename = "targetNodeId")]
    target_node_id: Option<String>,
}

#[derive(Default, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
enum InferenceProvider {
    MeshLlm,
    // Preserve the existing helper protocol; the desktop app selects mesh by default.
    #[default]
    Chatgpt,
}

impl Request {
    fn validate(&self) -> Result<(), &'static str> {
        if self.prompt.trim().is_empty() {
            return Err("Enter a message for Sig.");
        }
        if let Some(model) = &self.model {
            if model.trim().is_empty() || model.len() > 128 || model.chars().any(char::is_control) {
                return Err("Invalid model name.");
            }
        }
        match self.provider {
            InferenceProvider::MeshLlm => {
                if self.model.is_none() {
                    return Err("Sig's mesh model is missing.");
                }
                if !self.base_url.as_deref().is_some_and(is_mesh_base_url) {
                    return Err("Sig's local mesh endpoint is invalid.");
                }
                if self.target_node_id.as_ref().is_some_and(|node| {
                    node.len() != 64 || !node.bytes().all(|byte| byte.is_ascii_hexdigit())
                }) {
                    return Err("Sig's selected mesh node is invalid.");
                }
            }
            InferenceProvider::Chatgpt
                if self.base_url.is_some() || self.target_node_id.is_some() =>
            {
                return Err("Sig's ChatGPT endpoint cannot be overridden.");
            }
            InferenceProvider::Chatgpt => {}
        }
        Ok(())
    }
}

// Electron owns a separate sidecar and supplies its loopback port. Never accept a
// remote URL, credentials, query parameters, or another API path through stdin.
fn is_mesh_base_url(base_url: &str) -> bool {
    let Some(port_and_path) = base_url.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let Some(port) = port_and_path.strip_suffix("/v1") else {
        return false;
    };
    !port.is_empty()
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port != 0)
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
    request.validate()?;
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
    let provider = match request.provider {
        InferenceProvider::MeshLlm => {
            // Use the documented declarative provider to pin the API path. The
            // alpha12 openai_provider custom-URL parser strips /v1 incorrectly.
            // No key env var is configured, so no credential is read or sent.
            declarative_provider_from_json(
                serde_json::json!({
                    "name": "sig-mesh-llm",
                    "engine": "openai",
                    "display_name": "mesh-llm",
                    "base_url": request.base_url,
                    "base_path": "v1/chat/completions",
                    "api_key_env": "",
                    "requires_auth": false,
                    "models": [],
                    "timeout_seconds": 90,
                    "supports_streaming": true
                })
                .to_string(),
            )
        }
        InferenceProvider::Chatgpt => {
            let api_key = std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|key| !key.trim().is_empty())
                .ok_or("Sig's API credential is missing.")?;
            openai_provider(api_key, None)
        }
    }
    .map_err(|error| safe_error(&error))?;
    let model = ProviderModelConfig {
        model_name: request
            .model
            .unwrap_or_else(|| DEFAULT_CHATGPT_MODEL.to_owned()),
        context_limit: None,
        temperature: None,
        max_tokens: Some(2048),
        toolshim: false,
        toolshim_model: None,
        // Keep the established native OpenAI settings. Mesh gets the standard
        // Chat Completions payload without OpenAI-specific request extensions.
        request_params_json: match request.provider {
            InferenceProvider::Chatgpt => {
                Some(r#"{"thinking_effort":"off","store":false}"#.to_owned())
            }
            InferenceProvider::MeshLlm => None,
        },
        provider_params_json: None,
        reasoning: None,
        timeout_ms: Some(90_000),
        request_headers: request
            .target_node_id
            .map(|node| HashMap::from([("x-mesh-target".to_owned(), node)])),
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
        assert_eq!(request.provider, InferenceProvider::Chatgpt);
        assert!(request.validate().is_ok());
        assert!(
            serde_json::from_str::<Request>(r#"{"prompt":"hello","history":["secret"]}"#).is_err()
        );
        assert!(
            serde_json::from_str::<Request>(r#"{"prompt":"hello","tools":["shell"]}"#).is_err()
        );
    }

    #[test]
    fn validates_provider_and_owned_local_mesh_endpoint() {
        let request: Request = serde_json::from_str(
            r#"{"prompt":"hello","provider":"mesh-llm","model":"mesh-model","baseUrl":"http://127.0.0.1:49152/v1","targetNodeId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#,
        )
        .unwrap();
        assert_eq!(request.provider, InferenceProvider::MeshLlm);
        assert!(request.validate().is_ok());
        assert!(
            serde_json::from_str::<Request>(r#"{"prompt":"hello","provider":"unknown"}"#).is_err()
        );
        for base_url in [
            "https://api.openai.com/v1",
            "http://127.0.0.1:0/v1",
            "http://127.0.0.1:65536/v1",
            "http://127.0.0.1:49152/v1?secret=example",
            "http://127.0.0.1:49152/other",
            "http://127.0.0.1.example.com:49152/v1",
            "http://user@127.0.0.1:49152/v1",
        ] {
            assert!(!is_mesh_base_url(base_url));
        }
        let overridden_chatgpt: Request = serde_json::from_str(
            r#"{"prompt":"hello","provider":"chatgpt","baseUrl":"http://127.0.0.1:49152/v1"}"#,
        )
        .unwrap();
        assert!(overridden_chatgpt.validate().is_err());
        let invalid_target: Request = serde_json::from_str(
            r#"{"prompt":"hello","provider":"mesh-llm","model":"mesh-model","baseUrl":"http://127.0.0.1:49152/v1","targetNodeId":"node\r\nAuthorization: example"}"#,
        ).unwrap();
        assert!(invalid_target.validate().is_err());
    }

    #[tokio::test]
    async fn mesh_uses_chat_completions_without_any_api_credential() {
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut input = Vec::new();
            let header_end = loop {
                let mut buffer = [0; 4096];
                let length = connection.read(&mut buffer).unwrap();
                assert_ne!(length, 0);
                input.extend_from_slice(&buffer[..length]);
                if let Some(index) = input.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8(input[..header_end].to_vec()).unwrap();
            assert!(
                headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"),
                "Unexpected mesh request line: {}",
                headers.lines().next().unwrap()
            );
            assert!(!headers.to_ascii_lowercase().contains("authorization:"));
            assert!(headers.to_ascii_lowercase().contains(
                "x-mesh-target: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\r\n"
            ));
            let content_length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            while input.len() < header_end + content_length {
                let mut buffer = [0; 4096];
                let length = connection.read(&mut buffer).unwrap();
                assert_ne!(length, 0);
                input.extend_from_slice(&buffer[..length]);
            }
            let payload: serde_json::Value =
                serde_json::from_slice(&input[header_end..header_end + content_length]).unwrap();
            assert_eq!(payload["model"], "mesh-test-model");
            assert_eq!(payload["stream"], true);
            assert_eq!(payload["messages"].as_array().unwrap().len(), 2);
            assert_eq!(payload["messages"][0]["role"], "system");
            assert_eq!(payload["messages"][1]["role"], "user");
            assert_eq!(
                payload["messages"][1]["content"],
                "Only this submitted message."
            );
            assert!(payload.get("store").is_none());
            assert!(payload.get("thinking_effort").is_none());
            assert!(payload
                .get("tools")
                .is_none_or(|tools| tools.as_array().is_some_and(Vec::is_empty)));

            let response = concat!(
                "data: {\"id\":\"mesh-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"mesh-test-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Mesh reply\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"mesh-test\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"mesh-test-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            );
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        });
        let request = Request {
            prompt: "Only this submitted message.".to_owned(),
            provider: InferenceProvider::MeshLlm,
            model: Some("mesh-test-model".to_owned()),
            base_url: Some(format!("http://127.0.0.1:{port}/v1")),
            target_node_id: Some(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
            ),
        };
        request.validate().unwrap();
        assert!(answer(request).await.is_ok());
        server.join().unwrap();
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

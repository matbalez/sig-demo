// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

//! Mesh compatibility at the provider boundary. The GDK state machine still
//! owns every tool dispatch and inference continuation.

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use async_trait::async_trait;
use futures::StreamExt;
use goose_provider_types::{
    base::{MessageStream, Provider},
    conversation::message::{Message, MessageContent, ToolRequest, TOOL_META_PROVIDER_INDEX_KEY},
    errors::ProviderError,
    model::ModelConfig,
};
use rmcp::model::{CallToolRequestParams, Tool};

use crate::{
    brave::{is_search_name, SearchArguments},
    tool_compat::ToolTextFilter,
};

const INVALID_CALL: &str = "Sig returned an invalid web search request. Please try again.";
const CONFLICTING_CALL: &str = "Sig returned conflicting web search requests. Please try again.";
const UNSUPPORTED_CALL: &str =
    "Sig requested an unavailable tool. Only Brave web search is supported.";

pub struct CompatProvider {
    inner: Arc<dyn Provider>,
    turn: AtomicUsize,
}

impl CompatProvider {
    pub fn new(inner: Arc<dyn Provider>) -> Self {
        Self {
            inner,
            turn: AtomicUsize::new(0),
        }
    }
}

fn invalid(message: &'static str) -> ProviderError {
    ProviderError::ExecutionError(message.into())
}

fn normalize_request(request: &mut ToolRequest) -> Result<(), ProviderError> {
    if request.id.is_empty() || request.id.len() > 512 || request.id.chars().any(char::is_control) {
        return Err(invalid(INVALID_CALL));
    }
    if let Some(index) = request
        .tool_meta
        .as_ref()
        .and_then(|meta| meta.get(TOOL_META_PROVIDER_INDEX_KEY))
    {
        if !index.is_null() && index.as_u64().is_none() {
            return Err(invalid(INVALID_CALL));
        }
    }
    // Keep native malformed/truncated requests intact for the GDK boundary
    // operation, which classifies their structured error without exposing it.
    let Ok(call) = &mut request.tool_call else {
        return Ok(());
    };
    if !is_search_name(&call.name) {
        return Err(invalid(UNSUPPORTED_CALL));
    }
    if serde_json::to_vec(&call.arguments)
        .map_err(|_| invalid(INVALID_CALL))?
        .len()
        > 8192
    {
        return Err(invalid(INVALID_CALL));
    }
    let arguments: SearchArguments = serde_json::from_value(serde_json::Value::Object(
        call.arguments.clone().unwrap_or_default(),
    ))
    .map_err(|_| invalid(INVALID_CALL))?;
    arguments.validate().map_err(|_| invalid(INVALID_CALL))?;
    call.name = "brave_web_search".into();
    Ok(())
}

fn add_request(seen: &mut Vec<ToolRequest>, request: &ToolRequest) -> Result<bool, ProviderError> {
    let index = |request: &ToolRequest| {
        request
            .tool_meta
            .as_ref()
            .and_then(|meta| meta.get(TOOL_META_PROVIDER_INDEX_KEY))
            .and_then(serde_json::Value::as_u64)
    };
    if let Some(previous) = seen.iter().find(|previous| {
        previous.id == request.id || (index(request).is_some() && index(request) == index(previous))
    }) {
        return if previous == request {
            Ok(false)
        } else {
            Err(invalid(CONFLICTING_CALL))
        };
    }
    if seen.len() >= 8 {
        return Err(invalid("Sig returned too many web search requests."));
    }
    seen.push(request.clone());
    Ok(true)
}

#[async_trait]
impl Provider for CompatProvider {
    fn get_name(&self) -> &str {
        self.inner.get_name()
    }

    async fn stream(
        &self,
        model: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let mut stream = self.inner.stream(model, system, messages, tools).await?;
        let turn = self.turn.fetch_add(1, Ordering::Relaxed);
        Ok(Box::pin(async_stream::try_stream! {
            let mut filter = ToolTextFilter::new();
            let mut seen = Vec::new();
            let mut native = false;
            while let Some(result) = stream.next().await {
                let (mut message, usage) = result?;
                if let Some(message) = &mut message {
                    let mut content = Vec::with_capacity(message.content.len());
                    for block in message.content.drain(..) {
                        match block {
                            MessageContent::Text(mut text) => {
                                text.text = filter.push(&text.text);
                                if !text.text.is_empty() { content.push(MessageContent::Text(text)); }
                            }
                            MessageContent::ToolRequest(mut request) => {
                                native = true;
                                normalize_request(&mut request)?;
                                if add_request(&mut seen, &request)? {
                                    content.push(MessageContent::ToolRequest(request));
                                }
                            }
                            other => content.push(other),
                        }
                    }
                    message.content = content;
                }
                // Preserve empty messages too: completion/usage metadata and
                // output-limit flags belong to the native inference runner.
                yield (message, usage);
            }
            if !native {
                let (tail, calls) = filter.finish().map_err(invalid)?;
                let mut message = Message::assistant();
                if !tail.is_empty() { message = message.with_text(tail); }
                for (index, call) in calls.into_iter().enumerate() {
                    let arguments = serde_json::from_str(&call.arguments_json).map_err(|_| invalid(INVALID_CALL))?;
                    message = message.with_tool_request(
                        format!("sig-search-{turn}-{index}"),
                        Ok(CallToolRequestParams::new(call.name).with_arguments(arguments)),
                    );
                }
                if !message.content.is_empty() { yield (Some(message), None); }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goose_provider_types::conversation::token_usage::{ProviderUsage, Usage};
    use serde_json::json;

    struct FixtureProvider(Vec<Message>);

    #[async_trait]
    impl Provider for FixtureProvider {
        fn get_name(&self) -> &str {
            "fixture"
        }
        async fn stream(
            &self,
            _: &ModelConfig,
            _: &str,
            _: &[Message],
            _: &[Tool],
        ) -> Result<MessageStream, ProviderError> {
            Ok(Box::pin(futures::stream::iter(
                self.0.clone().into_iter().map(|message| {
                    Ok((
                        Some(message),
                        Some(ProviderUsage::new("fixture".into(), Usage::default())),
                    ))
                }),
            )))
        }
    }

    async fn collect(
        provider: &CompatProvider,
    ) -> Result<Vec<(Option<Message>, Option<ProviderUsage>)>, ProviderError> {
        use futures::TryStreamExt;
        provider
            .stream(&ModelConfig::new("fixture"), "fixture", &[], &[])
            .await?
            .try_collect()
            .await
    }

    #[tokio::test]
    async fn legacy_frames_become_native_requests_without_losing_usage_or_signed_thinking() {
        let frame =
            r#"<tool_call>{"name":"google_search","arguments":{"query":"SDK"}}</tool_call>"#;
        let mut messages = vec![Message::assistant().with_thinking("private reasoning", "signed")];
        messages.extend(
            frame
                .chars()
                .map(|character| Message::assistant().with_text(character.to_string())),
        );
        let provider = CompatProvider::new(Arc::new(FixtureProvider(messages)));
        let first = collect(&provider).await.unwrap();
        assert_eq!(
            first.iter().filter(|(_, usage)| usage.is_some()).count(),
            frame.chars().count() + 1
        );
        assert!(
            matches!(&first[0].0.as_ref().unwrap().content[0], MessageContent::Thinking(thinking) if thinking.signature == "signed")
        );
        let requests: Vec<_> = first
            .iter()
            .filter_map(|(message, _)| message.as_ref())
            .flat_map(|message| &message.content)
            .filter_map(MessageContent::as_tool_request)
            .collect();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].tool_call.as_ref().unwrap().name,
            "brave_web_search"
        );
        assert_eq!(requests[0].id, "sig-search-0-0");
        assert!(!first
            .iter()
            .filter_map(|(message, _)| message.as_ref())
            .flat_map(|message| &message.content)
            .any(|content| matches!(content, MessageContent::Text(_))));
        let second = collect(&provider).await.unwrap();
        let request = second
            .iter()
            .filter_map(|(message, _)| message.as_ref())
            .flat_map(|message| &message.content)
            .find_map(MessageContent::as_tool_request)
            .unwrap();
        assert_eq!(request.id, "sig-search-1-0");
    }

    #[tokio::test]
    async fn native_calls_override_printed_errors_and_preserve_metadata() {
        let metadata =
            serde_json::from_value(json!({"signature":"native-tool-signature"})).unwrap();
        let mut native = Message::assistant().with_tool_request_with_metadata(
            "native-id",
            Ok(CallToolRequestParams::new("search")
                .with_arguments(serde_json::from_value(json!({"query":"SDK"})).unwrap())),
            Some(&metadata),
            Some(json!({TOOL_META_PROVIDER_INDEX_KEY:0,"other":"preserved"})),
        );
        let mut expected = native.content[0].as_tool_request().unwrap().clone();
        expected.tool_call.as_mut().unwrap().name = "brave_web_search".into();
        native.metadata.output_token_limit_reached = true;
        let provider = CompatProvider::new(Arc::new(FixtureProvider(vec![
            Message::assistant().with_text("<tool_call>invalid</tool_call>"),
            native.clone(),
            native,
        ])));
        let output = collect(&provider).await.unwrap();
        assert!(
            output[1]
                .0
                .as_ref()
                .unwrap()
                .metadata
                .output_token_limit_reached
        );
        let requests: Vec<_> = output
            .iter()
            .filter_map(|(message, _)| message.as_ref())
            .flat_map(|message| &message.content)
            .filter_map(MessageContent::as_tool_request)
            .collect();
        assert_eq!(requests, vec![&expected]);
    }

    #[test]
    fn validates_ids_arguments_and_conflicting_native_calls() {
        let message = Message::assistant().with_tool_request(
            "id",
            Ok(CallToolRequestParams::new("web_search")
                .with_arguments(serde_json::from_value(json!({"query":"SDK"})).unwrap())),
        );
        let mut call = message.content[0].as_tool_request().unwrap().clone();
        normalize_request(&mut call).unwrap();
        let mut seen = Vec::new();
        assert!(add_request(&mut seen, &call).unwrap());
        assert!(!add_request(&mut seen, &call).unwrap());
        let mut conflict = call.clone();
        conflict.tool_call.as_mut().unwrap().arguments =
            Some(serde_json::from_value(json!({"query":"changed"})).unwrap());
        assert!(add_request(&mut seen, &conflict).is_err());
        call.id = "x".repeat(513);
        assert!(normalize_request(&mut call).is_err());
    }
}

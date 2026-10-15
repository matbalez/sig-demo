// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use async_trait::async_trait;
use futures::StreamExt;
use goose_agent::events::AgentEvent;
use goose_agent::inference::{InferenceEffect, InferenceRunner};
use goose_agent::machine::{EffectHandler, MachineSession, SessionLoader, StateMachine, Step};
use goose_agent::operation::{
    not_applicable, yielded, ConversationEffect, Emitter, MachineEffect, Operation, OperationResult,
};
use goose_agent::tool::{ToolOperation, ToolProvider};
use goose_provider_types::base::{MessageStream, Provider};
use goose_provider_types::conversation::message::{Message, MessageContent};
use goose_provider_types::conversation::token_usage::ProviderUsage;
use goose_provider_types::conversation::Conversation;
use goose_provider_types::errors::ProviderError;
use goose_provider_types::model::ModelConfig;
use goose_providers::api_client::{ApiClient, AuthMethod};
use goose_providers::declarative::EnvKeyResolver;
use goose_providers::openai::{OpenAiProviderBuilder, OPEN_AI_VERSIONLESS_BASE_PATH};
use rmcp::model::{CallToolRequestParams, CallToolResult, ErrorData, Tool};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::brave::{BraveSearch, SearchArguments};
use crate::compat_provider::CompatProvider;
use crate::context::{ContextOperation, MESH_TOOLS, SYSTEM};
use crate::errors::Failure;
use crate::sessions::{search_excerpt, RetainedTurn};
use crate::{
    SigAgentConfig, SigAgentEvent, SigAgentMode, SigAgentProvider, SigAgentRequest, SigAgentStatus,
};

#[derive(Clone)]
pub(crate) struct Session {
    id: String,
    pub conversation: Conversation,
    pub retained: Vec<RetainedTurn>,
}

impl MachineSession for Session {
    fn id(&self) -> &str {
        &self.id
    }
    fn conversation(&self) -> Option<&Conversation> {
        Some(&self.conversation)
    }
}

pub(crate) enum Effect {
    Conversation(ConversationEffect),
    Retain(Vec<RetainedTurn>),
    Usage(ProviderUsage),
}

impl From<Message> for Effect {
    fn from(message: Message) -> Self {
        Self::Conversation(ConversationEffect::AppendMessage(message))
    }
}
impl MachineEffect for Effect {
    fn ensure_message_ids(&mut self) {
        if let Self::Conversation(effect) = self {
            effect.ensure_message_ids();
        }
    }
}
impl InferenceEffect for Effect {
    fn record_usage(usage: ProviderUsage) -> Self {
        Self::Usage(usage)
    }
}

pub(crate) struct Memory {
    session: Mutex<Session>,
    gate: tokio::sync::Mutex<()>,
}

impl Default for Memory {
    fn default() -> Self {
        static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
        Self {
            session: Mutex::new(Session {
                id: format!(
                    "sig-session-{}",
                    NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
                ),
                conversation: Conversation::default(),
                retained: Vec::new(),
            }),
            gate: tokio::sync::Mutex::new(()),
        }
    }
}

#[async_trait]
impl SessionLoader<Session> for Memory {
    async fn load(&self, session_id: &str) -> Result<Session> {
        let session = self.session.lock().unwrap();
        if session.id != session_id {
            return Err(Failure::internal().into());
        }
        Ok(session.clone())
    }
}

#[async_trait]
impl EffectHandler<Session, Effect> for Memory {
    async fn apply_effects(
        &self,
        _session: &Session,
        effects: &mut [Effect],
        _emit: &Emitter,
    ) -> Result<()> {
        let mut session = self.session.lock().unwrap();
        for effect in effects {
            match effect {
                Effect::Retain(retained) => session.retained = retained.clone(),
                Effect::Conversation(ConversationEffect::AppendMessage(message)) => {
                    session.conversation.push(message.clone())
                }
                Effect::Conversation(ConversationEffect::ReplaceConversation(conversation)) => {
                    session.conversation = conversation.clone()
                }
                Effect::Conversation(ConversationEffect::SetMessageVisibility {
                    message_id,
                    user_visible,
                    agent_visible,
                }) => {
                    if let Some(message) = session
                        .conversation
                        .messages_mut()
                        .iter_mut()
                        .find(|message| message.id.as_ref() == Some(message_id))
                    {
                        message.metadata.user_visible = *user_visible;
                        message.metadata.agent_visible = *agent_visible;
                    }
                }
                Effect::Conversation(ConversationEffect::PatchToolRequestMeta { .. }) => {
                    return Err(Failure::internal().into())
                }
                Effect::Usage(usage) => {
                    let _ = &usage.usage;
                }
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Counts {
    turns: usize,
    searches: usize,
    completed_searches: usize,
    searches_at_last_turn: usize,
    seen: HashSet<String>,
    last_turn_text: bool,
    any_text: bool,
    response: String,
    search_context: Vec<serde_json::Value>,
}

struct Flow {
    events: mpsc::UnboundedSender<SigAgentEvent>,
    counts: Mutex<Counts>,
    failure: Mutex<Option<Failure>>,
    started: Instant,
    max_turns: usize,
}

impl Flow {
    fn emit(&self, event: SigAgentEvent) {
        let _ = self.events.send(event);
    }
    fn timing(&self, phase: &str, started: Instant) {
        self.emit(SigAgentEvent::Timing {
            phase: phase.into(),
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        });
    }
    fn fail(&self, failure: Failure) -> Failure {
        self.failure.lock().unwrap().get_or_insert(failure).clone()
    }
    fn failure(&self) -> Option<Failure> {
        self.failure.lock().unwrap().clone()
    }
    fn begin_turn(&self) -> Result<(), Failure> {
        if let Some(failure) = self.failure() {
            return Err(failure);
        }
        let mut counts = self.counts.lock().unwrap();
        // The upstream inference operation can retry empty responses. A new
        // request is permitted only after a real, newly completed local search.
        if counts.turns > 0 && counts.completed_searches <= counts.searches_at_last_turn {
            return Err(self.fail(Failure::empty()));
        }
        if counts.turns >= self.max_turns {
            return Err(self.fail(Failure::search_limit()));
        }
        counts.turns += 1;
        counts.searches_at_last_turn = counts.completed_searches;
        counts.last_turn_text = false;
        drop(counts);
        self.emit(SigAgentEvent::Status {
            status: SigAgentStatus::Responding,
        });
        self.emit(SigAgentEvent::Timing {
            phase: "model-turn".into(),
            duration_ms: 0,
        });
        Ok(())
    }
    fn observe_message(&self, message: &Message) {
        if message.metadata.output_token_limit_reached {
            self.fail(Failure::output_limit());
        }
        if message.role != rmcp::model::Role::Assistant || message.error_kind().is_some() {
            return;
        }
        if message.content.iter().any(
            |content| matches!(content, MessageContent::Text(text) if !text.text.trim().is_empty()),
        ) {
            let mut counts = self.counts.lock().unwrap();
            if !counts.any_text {
                self.timing("answer-first-text", self.started);
            }
            counts.any_text = true;
            counts.last_turn_text = true;
        }
    }
    fn provider_failure(&self, error: ProviderError) -> ProviderError {
        let failure = self.fail(Failure::from_provider(&error));
        ProviderError::ExecutionError(failure.message.into())
    }
}

struct GuardedProvider {
    inner: Arc<dyn Provider>,
    flow: Arc<Flow>,
}

#[async_trait]
impl Provider for GuardedProvider {
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
        self.flow
            .begin_turn()
            .map_err(|failure| ProviderError::ExecutionError(failure.message.into()))?;
        let stream = self
            .inner
            .stream(model, system, messages, tools)
            .await
            .map_err(|error| self.flow.provider_failure(error))?;
        let flow = Arc::clone(&self.flow);
        Ok(Box::pin(stream.map(move |result| match result {
            Ok((message, usage)) => {
                if let Some(message) = &message {
                    flow.observe_message(message);
                }
                Ok((message, usage))
            }
            Err(error) => Err(flow.provider_failure(error)),
        })))
    }
}

fn web_search_tool() -> Tool {
    Tool::new("brave_web_search", "Search the web for current external information. Returns extracted reference text and source URLs. Use focused search terms, not the whole chat.",
        Arc::new(serde_json::from_value(json!({
            "type": "object", "properties": {
                "query": {"type":"string","minLength":1,"maxLength":600},
                "freshness":{"type":"string","enum":["pd","pw","pm","py"]}
            }, "required":["query"], "additionalProperties":false
        })).expect("fixed search schema")))
}

struct BraveTools {
    search: BraveSearch,
    flow: Arc<Flow>,
}

#[async_trait]
impl ToolProvider<Session> for BraveTools {
    async fn tools(&self, _session: &Session) -> Result<Vec<Tool>> {
        Ok(vec![web_search_tool()])
    }
    async fn call(
        &self,
        _session: &Session,
        _request_id: &str,
        call: CallToolRequestParams,
        _emit: &Emitter,
    ) -> Result<CallToolResult, ErrorData> {
        let invalid = || ErrorData::invalid_params("Invalid web search request", None);
        if self.flow.failure().is_some() {
            return Err(invalid());
        }
        let arguments: SearchArguments = serde_json::from_value(serde_json::Value::Object(
            call.arguments.unwrap_or_default(),
        ))
        .map_err(|_| {
            self.flow.fail(Failure::tool_invalid());
            invalid()
        })?;
        arguments.validate().map_err(|_| {
            self.flow.fail(Failure::tool_invalid());
            invalid()
        })?;
        {
            let mut counts = self.flow.counts.lock().unwrap();
            if counts.searches >= 2 {
                self.flow.fail(Failure::search_limit());
                return Err(invalid());
            }
            if !counts.seen.insert(arguments.query.trim().to_lowercase()) {
                self.flow.fail(Failure::new(
                    "application-error",
                    "Sig repeated a web search instead of answering. Please try again.",
                ));
                return Err(invalid());
            }
            counts.searches += 1;
        }
        self.flow.emit(SigAgentEvent::Status {
            status: SigAgentStatus::Searching,
        });
        let started = Instant::now();
        let result = self.search.search(&arguments).await;
        self.flow.timing("search", started);
        self.flow.counts.lock().unwrap().completed_searches += 1;
        let failed = result.error.is_some();
        if let Some(excerpt) = search_excerpt(&result) {
            self.flow
                .counts
                .lock()
                .unwrap()
                .search_context
                .push(excerpt);
        }
        let mut result =
            CallToolResult::structured(serde_json::to_value(result).map_err(|_| invalid())?);
        result.is_error = Some(failed);
        Ok(result)
    }
}

struct Boundaries {
    flow: Arc<Flow>,
    tools: bool,
}

#[async_trait]
impl Operation<Session, Effect> for Boundaries {
    fn name(&self) -> &'static str {
        "sig_limits"
    }
    async fn run(
        &self,
        _session: &Session,
        conversation: &Conversation,
        _emit: &Emitter,
    ) -> Result<OperationResult<Effect>> {
        if self.flow.failure().is_some() {
            return yielded();
        }
        let answered: HashSet<&str> = conversation
            .messages()
            .iter()
            .flat_map(Message::get_tool_response_ids)
            .collect();
        let pending = conversation
            .messages()
            .iter()
            .flat_map(|message| &message.content)
            .filter_map(MessageContent::as_tool_request)
            .filter(|request| !answered.contains(request.id.as_str()))
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return not_applicable();
        }
        let counts = self.flow.counts.lock().unwrap();
        if !self.tools || pending.len() > 8 {
            self.flow.fail(Failure::tool_invalid());
            return yielded();
        }
        if counts.searches >= 2 || counts.turns >= 3 {
            self.flow.fail(Failure::search_limit());
            return yielded();
        }
        drop(counts);
        for request in pending {
            if let Err(error) = &request.tool_call {
                self.flow.fail(
                    if error
                        .message
                        .starts_with("The model's response was truncated")
                    {
                        Failure::tool_incomplete()
                    } else {
                        Failure::tool_invalid()
                    },
                );
                return yielded();
            }
            let valid = request.id.len() <= 512
                && !request.id.is_empty()
                && !request.id.chars().any(char::is_control)
                && request.tool_call.as_ref().is_ok_and(|call| {
                    call.name == "brave_web_search"
                        && serde_json::to_vec(&call.arguments)
                            .is_ok_and(|bytes| bytes.len() <= 8192)
                });
            if !valid {
                self.flow.fail(Failure::tool_invalid());
                return yielded();
            }
        }
        not_applicable()
    }
}

fn provider(config: &SigAgentConfig) -> Result<Arc<dyn Provider>, Failure> {
    if config.model.trim().is_empty()
        || config.model.len() > 128
        || config.model.chars().any(char::is_control)
    {
        return Err(Failure::new("application-error", "Invalid model name."));
    }
    if config.provider == SigAgentProvider::MeshLlm {
        let valid_url = config
            .base_url
            .as_deref()
            .and_then(|raw| reqwest::Url::parse(raw).ok())
            .is_some_and(|url| {
                url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port().is_some()
                    && url.path() == "/v1"
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.username().is_empty()
                    && url.password().is_none()
            });
        let valid_target = config
            .target_node_id
            .as_ref()
            .is_none_or(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        if !valid_url || !valid_target {
            return Err(Failure::new(
                "application-error",
                "Sig's local mesh endpoint is invalid.",
            ));
        }
        goose_providers::declarative::from_json(&json!({
            "name":"sig-mesh-llm", "engine":"openai", "display_name":"mesh-llm",
            "base_url":config.base_url, "base_path":"v1/chat/completions",
            "api_key_env":"", "requires_auth":false,"models":[], "timeout_seconds":90,"supports_streaming":true
        }).to_string(), None, EnvKeyResolver {}).map(Arc::from).map_err(|_| Failure::internal())
    } else {
        if config.base_url.is_some() || config.target_node_id.is_some() {
            return Err(Failure::new(
                "application-error",
                "Sig's ChatGPT endpoint cannot be overridden.",
            ));
        }
        let key = config
            .api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
            .ok_or(Failure::new(
                "application-error",
                "Sig's API credential is missing.",
            ))?;
        let client = ApiClient::with_timeout_and_tls(
            "https://api.openai.com".into(),
            AuthMethod::BearerToken(key.into()),
            Duration::from_secs(90),
            None,
        )
        .map_err(|_| Failure::internal())?;
        Ok(Arc::new(
            OpenAiProviderBuilder::new(client)
                .base_path(OPEN_AI_VERSIONLESS_BASE_PATH)
                .native_openai(true)
                .preserve_thinking_context(false)
                .build(),
        ))
    }
}

fn model(config: &SigAgentConfig, max_tokens: i32) -> ModelConfig {
    let params = if config.provider == SigAgentProvider::Chatgpt {
        json!({"thinking_effort":"off","store":false,"web_search":true,"max_tool_calls":2})
    } else {
        json!({"chat_template_kwargs":{"enable_thinking":false},"tool_choice":"auto","parallel_tool_calls":false})
    };
    let headers = config
        .target_node_id
        .as_ref()
        .map(|id| std::collections::HashMap::from([("x-mesh-target".into(), id.clone())]));
    ModelConfig::new(&config.model)
        .with_max_tokens(Some(max_tokens))
        .with_toolshim(false)
        .with_merged_request_params(serde_json::from_value(params).expect("fixed model parameters"))
        .with_request_headers(headers)
}

fn forward(event: AgentEvent, flow: &Flow) {
    if let AgentEvent::Message(message) = event {
        // Provider failures are sanitized by GuardedProvider, and never travel
        // through the normal answer-text channel, even as hidden Goose messages.
        if message.role != rmcp::model::Role::Assistant
            || message.error_kind().is_some()
            || !message.is_user_visible()
        {
            return;
        }
        for content in message.content {
            if let MessageContent::Text(text) = content {
                if !text.text.is_empty() {
                    // This is exactly the string concatenated into Signal's
                    // completed reply; unsuccessful/oversized replies are not cached.
                    let mut counts = flow.counts.lock().unwrap();
                    if counts.response.len() <= 65_536 {
                        if counts.response.len() + text.text.len() <= 65_536 {
                            counts.response.push_str(&text.text);
                        } else {
                            // A fixed overflow marker prevents an unbounded
                            // private cache without altering emitted text.
                            counts.response = "x".repeat(65_537);
                        }
                    }
                    drop(counts);
                    flow.emit(SigAgentEvent::Text { text: text.text });
                }
            }
        }
    }
}

async fn answer(
    config: &SigAgentConfig,
    request: SigAgentRequest,
    flow: Arc<Flow>,
    cancel: CancellationToken,
    memory: &Memory,
) -> Result<(), Failure> {
    let inner = provider(config)?;
    let mesh = config.provider == SigAgentProvider::MeshLlm;
    let search = if mesh {
        config
            .brave_api_key
            .as_deref()
            .map(BraveSearch::new)
            .transpose()
            .map_err(|_| Failure::new("application-error", "The search credential is invalid."))?
    } else {
        None
    };
    answer_in_memory(config, request, flow, cancel, inner, search, memory).await
}

#[cfg(test)]
async fn answer_with_components(
    config: &SigAgentConfig,
    request: SigAgentRequest,
    flow: Arc<Flow>,
    cancel: CancellationToken,
    inner: Arc<dyn Provider>,
    search: Option<BraveSearch>,
) -> Result<(), Failure> {
    answer_in_memory(
        config,
        request,
        flow,
        cancel,
        inner,
        search,
        &Memory::default(),
    )
    .await
}

async fn answer_in_memory(
    config: &SigAgentConfig,
    request: SigAgentRequest,
    flow: Arc<Flow>,
    cancel: CancellationToken,
    inner: Arc<dyn Provider>,
    search: Option<BraveSearch>,
    memory: &Memory,
) -> Result<(), Failure> {
    let completed_request = request.clone();
    let mesh = config.provider == SigAgentProvider::MeshLlm;
    let search = if mesh { search } else { None };
    let has_tools = search.is_some();
    let inner: Arc<dyn Provider> = if mesh {
        Arc::new(CompatProvider::new(inner))
    } else {
        inner
    };
    let guarded: Arc<dyn Provider> = Arc::new(GuardedProvider {
        inner,
        flow: Arc::clone(&flow),
    });
    let mut tools = ToolOperation::<Session>::new();
    if let Some(search) = search {
        tools = tools.with_provider(Arc::new(BraveTools {
            search,
            flow: Arc::clone(&flow),
        }));
    }
    let steps = vec![
        Step::Operation(Arc::new(ContextOperation::new(request, mesh, has_tools))),
        Step::Operation(Arc::new(Boundaries {
            flow: Arc::clone(&flow),
            tools: has_tools,
        })),
        Step::Operation(Arc::new(tools)),
        Step::Inference(Arc::new(InferenceRunner::<Session, Effect>::new(
            guarded,
            model(config, 2048),
        ))),
    ];
    let machine = StateMachine::new(steps, cancel.clone());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let emit = Emitter::new(tx, cancel.clone());
    let result = {
        let session_id = memory.session.lock().unwrap().id.clone();
        let run = machine.run(memory, &session_id, &emit);
        tokio::pin!(run);
        loop {
            tokio::select! {
                biased;
                result = &mut run => break result,
                event = rx.recv() => { if let Some(event) = event { forward(event,&flow); } }
            }
        }
    };
    while let Ok(event) = rx.try_recv() {
        forward(event, &flow);
    }
    if cancel.is_cancelled() {
        return Err(Failure::cancelled());
    }
    if let Some(failure) = flow.failure() {
        return Err(failure);
    }
    let completed_session = result.map_err(|error| {
        error
            .downcast_ref::<Failure>()
            .cloned()
            .unwrap_or_else(Failure::internal)
    })?;
    if !flow.counts.lock().unwrap().last_turn_text {
        return Err(Failure::empty());
    }
    let completed = {
        let counts = flow.counts.lock().unwrap();
        completed_session
            .conversation
            .messages()
            .iter()
            .rev()
            .find(|message| {
                message.role == rmcp::model::Role::Assistant && message.error_kind().is_none()
            })
            .and_then(|assistant| {
                RetainedTurn::completed(
                    &completed_request,
                    counts.response.clone(),
                    counts.search_context.clone(),
                    assistant.clone(),
                )
            })
    };
    if let Some(turn) = completed {
        let session = memory.session.lock().unwrap().clone();
        let mut retained = session.retained.clone();
        retained.retain(|prior| {
            prior.query_id != turn.query_id && prior.response_id != turn.response_id
        });
        retained.push(turn);
        if retained.len() > 12 {
            retained.remove(0);
        }
        memory
            .apply_effects(&session, &mut [Effect::Retain(retained)], &emit)
            .await
            .map_err(|_| Failure::internal())?;
    }
    flow.timing("answer", flow.started);
    Ok(())
}

async fn warmup(
    config: &SigAgentConfig,
    request: &SigAgentRequest,
    flow: &Flow,
) -> Result<(), Failure> {
    if config.provider != SigAgentProvider::MeshLlm
        || config.target_node_id.is_none()
        || !request.prompt.is_empty()
        || !request.query_id.is_empty()
        || !request.response_id.is_empty()
        || !request.source_text.is_empty()
        || request.author.is_some()
        || !request.history.is_empty()
        || request.current_date.is_some()
    {
        return Err(Failure::new(
            "application-error",
            "Invalid mesh warmup request.",
        ));
    }
    let provider = provider(config)?;
    let user = Message::user().with_text(json!({"recentHistory":[],"currentRequest":{"author":"Warmup","text":"Return exactly READY. Do not call a tool or search."}}).to_string());
    let started = Instant::now();
    tokio::time::timeout(
        Duration::from_secs(12),
        provider.complete(
            &model(config, 40),
            &format!("{SYSTEM}\n\n{MESH_TOOLS}"),
            &[user],
            &[web_search_tool()],
        ),
    )
    .await
    .map_err(|_| Failure::timeout())?
    .map_err(|error| Failure::from_provider(&error))?;
    flow.timing("warmup", started);
    Ok(())
}

pub(crate) async fn run(
    config: SigAgentConfig,
    request: SigAgentRequest,
    events: mpsc::UnboundedSender<SigAgentEvent>,
    cancel: CancellationToken,
    memory: Arc<Memory>,
) {
    let warm = request.mode == SigAgentMode::Warmup;
    let flow = Arc::new(Flow {
        events,
        counts: Mutex::new(Counts::default()),
        failure: Mutex::new(None),
        started: Instant::now(),
        max_turns: if config.provider == SigAgentProvider::MeshLlm && config.brave_api_key.is_some()
        {
            3
        } else {
            1
        },
    });
    let operation = async {
        if warm {
            warmup(&config, &request, &flow).await
        } else {
            // A fresh state machine/provider/Flow uses the owned persistent
            // session. The native lease serializes all runs on this handle;
            // TypeScript only retains the handle and forwards events.
            let _lease = memory.gate.lock().await;
            answer(&config, request, Arc::clone(&flow), cancel.clone(), &memory).await
        }
    };
    let result = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(if warm{15}else{120}),operation) => result.unwrap_or_else(|_|Err(Failure::timeout())),
        _ = cancel.cancelled() => Err(Failure::cancelled()),
    };
    match result {
        Ok(()) => flow.emit(SigAgentEvent::Done),
        Err(failure) => flow.emit(SigAgentEvent::Error {
            code: failure.code.into(),
            message: failure.message.into(),
            http_status: failure.http_status,
            reason_code: failure.reason_code.map(String::from),
        }),
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

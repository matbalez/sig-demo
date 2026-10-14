// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

use super::*;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

struct Snapshot {
    system: String,
    messages: Vec<Message>,
    tools: Vec<Tool>,
}
struct ScriptProvider {
    script: Mutex<VecDeque<Vec<Message>>>,
    requests: Mutex<Vec<Snapshot>>,
}

impl ScriptProvider {
    fn new(script: Vec<Vec<Message>>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            requests: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl Provider for ScriptProvider {
    fn get_name(&self) -> &str {
        "fixture"
    }
    async fn stream(
        &self,
        _: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        self.requests.lock().unwrap().push(Snapshot {
            system: system.into(),
            messages: messages.to_vec(),
            tools: tools.to_vec(),
        });
        let messages = self.script.lock().unwrap().pop_front().ok_or_else(|| {
            ProviderError::ExecutionError("Unexpected additional inference".into())
        })?;
        Ok(Box::pin(futures::stream::iter(
            messages
                .into_iter()
                .map(|message| Ok((Some(message), None))),
        )))
    }
}

fn fixture() -> (
    SigAgentConfig,
    SigAgentRequest,
    Arc<Flow>,
    mpsc::UnboundedReceiver<SigAgentEvent>,
) {
    let config = SigAgentConfig {
        provider: SigAgentProvider::MeshLlm,
        model: "fixture".into(),
        base_url: Some("http://127.0.0.1:1/v1".into()),
        target_node_id: Some("a".repeat(64)),
        api_key: None,
        brave_api_key: Some("synthetic-key".into()),
    };
    let request = SigAgentRequest {
        mode: SigAgentMode::Answer,
        query_id: "query-1".into(),
        response_id: "reply-1".into(),
        source_text: "@sig What about that?".into(),
        prompt: "What about that?".into(),
        author: Some(" Alice ".into()),
        history: vec![crate::SigHistoryMessage {
            id: "earlier-answer".into(),
            role: crate::SigHistoryRole::Assistant,
            author: "ignored".into(),
            text: "Earlier quoted answer".into(),
        }],
        current_date: Some("2026-10-14".into()),
    };
    let (events, receiver) = mpsc::unbounded_channel();
    let flow = Arc::new(Flow {
        events,
        counts: Mutex::new(Counts::default()),
        failure: Mutex::new(None),
        started: Instant::now(),
        max_turns: 3,
    });
    (config, request, flow, receiver)
}

#[tokio::test]
async fn native_machine_owns_context_and_ordinary_answer_is_one_inference() {
    let (config, request, flow, mut events) = fixture();
    let provider = ScriptProvider::new(vec![vec![Message::assistant().with_text("One answer.")]]);
    answer_with_components(
        &config,
        request,
        flow,
        CancellationToken::new(),
        provider.clone(),
        None,
    )
    .await
    .unwrap();
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0]
        .system
        .contains("Answer only currentRequest.text"));
    let text = requests[0].messages[0].as_concat_text();
    assert!(text.find("recentHistory").unwrap() < text.find("currentRequest").unwrap());
    let input: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(input["currentRequest"]["author"], "Alice");
    assert_eq!(input["recentHistory"][0]["author"], "Sig");
    assert!(!text.contains("synthetic-key"));
    let mut visible = String::new();
    while let Ok(event) = events.try_recv() {
        if let SigAgentEvent::Text { text } = event {
            visible.push_str(&text);
        }
    }
    assert_eq!(visible, "One answer.");
}

#[tokio::test]
async fn upstream_empty_retry_never_reaches_the_provider_again() {
    let (config, request, flow, _) = fixture();
    let provider = ScriptProvider::new(vec![
        Vec::new(),
        vec![Message::assistant().with_text("Must not be requested")],
    ]);
    let failure = answer_with_components(
        &config,
        request,
        flow,
        CancellationToken::new(),
        provider.clone(),
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    assert_eq!(failure.message, Failure::empty().message);
}

#[tokio::test]
async fn actual_output_limit_and_incomplete_arguments_are_distinct_without_search() {
    for limited in [false, true] {
        let (config, request, flow, _) = fixture();
        let mut message = Message::assistant().with_tool_request("call-test",Err(ErrorData::invalid_params("The model's response was truncated — it hit the output token limit. private payload",None)));
        message.metadata.output_token_limit_reached = limited;
        let provider = ScriptProvider::new(vec![vec![message]]);
        let failure = answer_with_components(
            &config,
            request,
            flow,
            CancellationToken::new(),
            provider.clone(),
            Some(BraveSearch::new("synthetic-key").unwrap()),
        )
        .await
        .unwrap_err();
        assert_eq!(
            failure.code,
            if limited {
                "output-token-limit"
            } else {
                "tool-arguments-incomplete"
            }
        );
        assert!(!failure.message.contains("private payload"));
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
    }
}

fn brave_server() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/search", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let task = thread::spawn(move || {
        let started = Instant::now();
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(value) => break value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(started.elapsed() < Duration::from_secs(8));
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut buffer = [0; 4096];
            let n = stream.read(&mut buffer).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]).to_ascii_lowercase();
        assert!(headers.contains("x-subscription-token: synthetic-key"));
        let length: usize = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length: "))
            .unwrap()
            .parse()
            .unwrap();
        while bytes.len() < header_end + length {
            let mut buffer = [0; 4096];
            let n = stream.read(&mut buffer).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
        }
        let request: serde_json::Value =
            serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
        assert_eq!(request["q"], "Rust GDK");
        let body=json!({"grounding":{"generic":[{"title":"Fixture source","url":"https://example.test/source","snippets":["A bounded local result"]}]}}).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    });
    (endpoint, task)
}

#[tokio::test]
async fn real_state_machine_dispatches_native_brave_and_continues_once() {
    let (config, request, flow, mut events) = fixture();
    let first_request = request.clone();
    let memory = Memory::default();
    let (endpoint, server) = brave_server();
    let provider = ScriptProvider::new(vec![
        vec![Message::assistant().with_text(
            r#"<tool_call>{"name":"google_search","arguments":{"query":"Rust GDK"}}</tool_call>"#,
        )],
        vec![Message::assistant().with_text("Found https://example.test/source")],
    ]);
    tokio::time::timeout(
        Duration::from_secs(8),
        answer_in_memory(
            &config,
            request,
            flow.clone(),
            CancellationToken::new(),
            provider.clone(),
            Some(BraveSearch::for_test("synthetic-key", &endpoint)),
            &memory,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    server.join().unwrap();
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].tools[0].name, "brave_web_search");
        let response = requests[1]
            .messages
            .iter()
            .flat_map(|message| &message.content)
            .find_map(MessageContent::as_tool_response)
            .unwrap();
        assert_eq!(response.id, "sig-search-0-0");
        let result = response.tool_result.as_ref().unwrap();
        assert!(serde_json::to_string(result)
            .unwrap()
            .contains("https://example.test/source"));
    }
    assert_eq!(flow.counts.lock().unwrap().searches, 1);
    let mut text = String::new();
    while let Ok(event) = events.try_recv() {
        if let SigAgentEvent::Text { text: chunk } = event {
            text.push_str(&chunk);
        }
    }
    assert_eq!(text, "Found https://example.test/source");

    // A new invocation runs a fresh genuine state machine on the same native
    // session. Only neutral, bounded references cross the invocation boundary.
    let (_, mut followup, followup_flow, _) = fixture();
    followup.query_id = "query-2".into();
    followup.response_id = "reply-2".into();
    followup.source_text = "@sig What did that source say?".into();
    followup.history = anchored_history(&first_request, &text);
    let followup_provider = ScriptProvider::new(vec![vec![
        Message::assistant().with_text("It explained the SDK.")
    ]]);
    answer_in_memory(
        &config,
        followup,
        followup_flow,
        CancellationToken::new(),
        followup_provider.clone(),
        None,
        &memory,
    )
    .await
    .unwrap();
    let requests = followup_provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].messages[1].role, rmcp::model::Role::Assistant);
    assert_eq!(requests[0].messages[1].as_concat_text(), text);
    assert!(
        requests[0]
            .messages
            .iter()
            .flat_map(|message| &message.content)
            .all(|content| content.as_tool_request().is_none()
                && content.as_tool_response().is_none())
    );
    let current: serde_json::Value =
        serde_json::from_str(&requests[0].messages.last().unwrap().as_concat_text()).unwrap();
    assert!(current["recentSearchContext"]
        .to_string()
        .contains("https://example.test/source"));
    assert!(
        serde_json::to_vec(&current["recentSearchContext"])
            .unwrap()
            .len()
            <= 2048
    );
    assert!(!current.to_string().contains("query-1"));
    assert!(!current.to_string().contains("reply-1"));
}

fn anchored_history(request: &SigAgentRequest, response: &str) -> Vec<crate::SigHistoryMessage> {
    vec![
        crate::SigHistoryMessage {
            id: request.query_id.clone(),
            role: crate::SigHistoryRole::User,
            author: "Alice".into(),
            text: request.source_text.clone(),
        },
        crate::SigHistoryMessage {
            id: request.response_id.clone(),
            role: crate::SigHistoryRole::Assistant,
            author: "Sig".into(),
            text: response.into(),
        },
    ]
}

#[tokio::test]
async fn reusable_native_session_retains_eligible_answers_and_prunes_edits_or_absence() {
    let memory = Memory::default();
    let native_id = memory.session.lock().unwrap().id.clone();
    let (config, first, flow, _) = fixture();
    let first_provider = ScriptProvider::new(vec![vec![
        Message::assistant().with_text("retained-marker")
    ]]);
    answer_in_memory(
        &config,
        first.clone(),
        flow,
        CancellationToken::new(),
        first_provider,
        None,
        &memory,
    )
    .await
    .unwrap();
    assert_eq!(memory.session.lock().unwrap().retained.len(), 1);

    for case in ["valid", "edited", "deleted"] {
        let (_, mut request, flow, _) = fixture();
        request.query_id = format!("next-{case}");
        request.response_id = format!("response-{case}");
        request.history = anchored_history(&first, "retained-marker");
        if case == "edited" {
            request.history[0].text.push_str(" edited");
        }
        if case == "deleted" {
            request.history.clear();
        }
        let provider =
            ScriptProvider::new(vec![vec![Message::assistant().with_text("new answer")]]);
        answer_in_memory(
            &config,
            request,
            flow,
            CancellationToken::new(),
            provider.clone(),
            None,
            &memory,
        )
        .await
        .unwrap();
        let requests = provider.requests.lock().unwrap();
        let prior = requests[0].messages.iter().find(|message| {
            message.role == rmcp::model::Role::Assistant
                && message.as_concat_text() == "retained-marker"
        });
        assert_eq!(prior.is_some(), case == "valid");
        assert_eq!(memory.session.lock().unwrap().id, native_id);
    }
}

#[tokio::test]
async fn different_native_sessions_never_reuse_each_others_answers() {
    let first_memory = Memory::default();
    let other_memory = Memory::default();
    assert_ne!(
        first_memory.session.lock().unwrap().id,
        other_memory.session.lock().unwrap().id
    );
    let (config, first, flow, _) = fixture();
    answer_in_memory(
        &config,
        first.clone(),
        flow,
        CancellationToken::new(),
        ScriptProvider::new(vec![vec![Message::assistant().with_text("private-marker")]]),
        None,
        &first_memory,
    )
    .await
    .unwrap();
    let (_, mut request, flow, _) = fixture();
    request.history = anchored_history(&first, "private-marker");
    let provider = ScriptProvider::new(vec![vec![Message::assistant().with_text("other answer")]]);
    answer_in_memory(
        &config,
        request,
        flow,
        CancellationToken::new(),
        provider.clone(),
        None,
        &other_memory,
    )
    .await
    .unwrap();
    // Signal's explicit shared transcript may quote the marker, but it must not
    // become an independently retained native answer in another owned scope.
    assert!(!provider.requests.lock().unwrap()[0]
        .messages
        .iter()
        .any(|message| message.role == rmcp::model::Role::Assistant));
}

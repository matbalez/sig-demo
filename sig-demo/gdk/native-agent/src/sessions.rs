// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

//! Small, provider-neutral continuation data anchored to Signal's transcript.
use std::collections::{HashMap, HashSet};

use goose_provider_types::conversation::message::Message;
use serde_json::{json, Value};

use crate::brave::SearchResult;
use crate::{SigAgentRequest, SigHistoryMessage, SigHistoryRole};

#[derive(Clone)]
pub(crate) struct RetainedTurn {
    pub query_id: String,
    pub response_id: String,
    source_text: String,
    response_text: String,
    pub assistant: Message,
    pub searches: Vec<Value>,
}

impl RetainedTurn {
    pub fn completed(
        request: &SigAgentRequest,
        response: String,
        searches: Vec<Value>,
        mut assistant: Message,
    ) -> Option<Self> {
        // Large answers can still be shown; they simply are not cached privately.
        if request.query_id.is_empty()
            || request.response_id.is_empty()
            || request.query_id == request.response_id
            || request.source_text.len() > 65_536
            || response.is_empty()
            || response.len() > 65_536
        {
            return None;
        }
        assistant.content = Message::assistant().with_text(&response).content;
        assistant.metadata = Default::default();
        Some(Self {
            query_id: request.query_id.clone(),
            response_id: request.response_id.clone(),
            source_text: request.source_text.clone(),
            response_text: response,
            assistant,
            searches,
        })
    }
}

pub(crate) fn reconcile(
    request: &SigAgentRequest,
    selected: &[SigHistoryMessage],
    retained: &[RetainedTurn],
) -> Vec<RetainedTurn> {
    let mut raw = HashMap::new();
    for message in &request.history {
        if message.id.is_empty() || raw.insert(message.id.as_str(), message).is_some() {
            // An incomplete or ambiguous snapshot must not retain private data.
            return Vec::new();
        }
    }
    let selected_ids: HashSet<&str> = selected.iter().map(|message| message.id.as_str()).collect();
    retained
        .iter()
        .filter(|turn| {
            selected_ids.contains(turn.query_id.as_str())
                && selected_ids.contains(turn.response_id.as_str())
                && raw.get(turn.query_id.as_str()).is_some_and(|message| {
                    matches!(message.role, SigHistoryRole::User) && message.text == turn.source_text
                })
                && raw.get(turn.response_id.as_str()).is_some_and(|message| {
                    matches!(message.role, SigHistoryRole::Assistant)
                        && message.text == turn.response_text
                })
        })
        .cloned()
        .collect()
}

fn prefix(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].into()
}

pub(crate) fn search_excerpt(result: &SearchResult) -> Option<Value> {
    if result.error.is_some() {
        return None;
    }
    let mut sources = Vec::new();
    for source in result.sources.iter().take(3) {
        if source.url.len() > 400 {
            continue;
        }
        let item = json!({
            "title": prefix(&source.title, 120),
            "url": source.url,
            "text": prefix(&source.text, 300),
        });
        sources.push(item);
        let candidate = json!({"query":prefix(&result.query, 160), "sources":sources});
        if serde_json::to_vec(&candidate).ok()?.len() > 2046 {
            sources.pop();
            break;
        }
    }
    (!sources.is_empty()).then(|| json!({"query":prefix(&result.query,160),"sources":sources}))
}

pub(crate) fn bounded_searches(retained: &[RetainedTurn]) -> Vec<Value> {
    let mut selected = Vec::new();
    for search in retained
        .iter()
        .rev()
        .flat_map(|turn| turn.searches.iter().rev())
    {
        selected.push(search.clone());
        if serde_json::to_vec(&selected).map_or(true, |bytes| bytes.len() > 2048) {
            selected.pop();
            break;
        }
    }
    selected.reverse();
    selected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brave::SearchSource;
    use crate::{SigAgentMode, SigHistoryRole};

    #[test]
    fn prior_search_references_have_a_separate_two_kib_budget_and_intact_urls() {
        let valid_url = "https://example.test/complete?query=one&two=three";
        let result = SearchResult {
            query: "🙂".repeat(300),
            sources: vec![
                SearchSource {
                    title: "Too long".into(),
                    url: format!("https://example.test/{}", "x".repeat(500)),
                    text: "omit".into(),
                },
                SearchSource {
                    title: "🌲".repeat(100),
                    url: valid_url.into(),
                    text: "🙂".repeat(500),
                },
            ],
            error: None,
        };
        let excerpt = search_excerpt(&result).unwrap();
        assert_eq!(excerpt["sources"].as_array().unwrap().len(), 1);
        assert_eq!(excerpt["sources"][0]["url"], valid_url);
        let turns = (0..12)
            .map(|index| RetainedTurn {
                query_id: format!("query-{index}"),
                response_id: format!("reply-{index}"),
                source_text: "query".into(),
                response_text: "reply".into(),
                assistant: Message::assistant().with_text("reply"),
                searches: vec![excerpt.clone()],
            })
            .collect::<Vec<_>>();
        let selected = bounded_searches(&turns);
        assert!(!selected.is_empty());
        assert!(serde_json::to_vec(&selected).unwrap().len() <= 2048);
    }

    #[test]
    fn reconciliation_uses_exact_raw_text_before_bounded_tail_projection() {
        let source = format!("old-prefix{}", "🙂".repeat(600));
        let mut request = SigAgentRequest {
            mode: SigAgentMode::Answer,
            query_id: "next-query".into(),
            response_id: "next-reply".into(),
            source_text: "@sig follow up".into(),
            prompt: "follow up".into(),
            author: None,
            current_date: None,
            history: vec![
                SigHistoryMessage {
                    id: "query".into(),
                    role: SigHistoryRole::User,
                    author: "Alice".into(),
                    text: source.clone(),
                },
                SigHistoryMessage {
                    id: "reply".into(),
                    role: SigHistoryRole::Assistant,
                    author: "Sig".into(),
                    text: "answer".into(),
                },
            ],
        };
        let retained = vec![RetainedTurn {
            query_id: "query".into(),
            response_id: "reply".into(),
            source_text: source,
            response_text: "answer".into(),
            assistant: Message::assistant().with_text("answer"),
            searches: vec![],
        }];
        let selected = crate::context::bounded_history(&request.history);
        assert_eq!(reconcile(&request, &selected, &retained).len(), 1);
        request.history[0].text.replace_range(..10, "new-prefix");
        let edited_selected = crate::context::bounded_history(&request.history);
        assert_eq!(selected[0].text, edited_selected[0].text);
        assert!(reconcile(&request, &edited_selected, &retained).is_empty());
    }
}

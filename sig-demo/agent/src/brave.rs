// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

//! The only local tool: bounded Brave search. Credentials never become model input.
use std::time::Duration;

use reqwest::{header::HeaderValue, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const ENDPOINT: &str = "https://api.search.brave.com/res/v1/llm/context";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_RESULT_BYTES: usize = 6000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SearchArguments {
    pub query: String,
    pub freshness: Option<String>,
}

impl SearchArguments {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.query.trim().is_empty()
            || self.query.chars().count() > 600
            || self.query.split_whitespace().count() > 75
            || self.query.chars().any(char::is_control)
        {
            return Err("The web search query is invalid or too long.");
        }
        if self
            .freshness
            .as_deref()
            .is_some_and(|value| !matches!(value, "pd" | "pw" | "pm" | "py"))
        {
            return Err("The web search freshness filter is invalid.");
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct SearchResult {
    pub query: String,
    pub sources: Vec<SearchSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

#[derive(Serialize)]
pub struct SearchSource {
    pub title: String,
    pub url: String,
    pub text: String,
}

impl SearchResult {
    pub fn failure(query: &str, message: &'static str) -> Self {
        Self {
            query: truncate_utf8(query, 2400),
            sources: vec![],
            error: Some(message),
        }
    }
}

pub struct BraveSearch {
    client: Client,
    key: HeaderValue,
    endpoint: String,
}

impl BraveSearch {
    pub fn from_environment() -> Option<Self> {
        let key = std::env::var("BRAVE_SEARCH_API_KEY").ok()?;
        if key.trim().is_empty() {
            return None;
        }
        Self::new(&key, ENDPOINT).ok()
    }

    fn new(key: &str, endpoint: &str) -> Result<Self, &'static str> {
        let mut key =
            HeaderValue::from_str(key).map_err(|_| "The search credential is invalid.")?;
        key.set_sensitive(true);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "The local web search tool could not start.")?;
        Ok(Self {
            client,
            key,
            endpoint: endpoint.to_owned(),
        })
    }

    #[cfg(test)]
    pub fn for_test(key: &str, endpoint: &str) -> Self {
        Self::new(key, endpoint).unwrap()
    }

    pub async fn search(&self, arguments: &SearchArguments) -> SearchResult {
        match self.fetch(arguments).await {
            Ok(result) => result,
            Err(message) => SearchResult::failure(&arguments.query, message),
        }
    }

    async fn fetch(&self, arguments: &SearchArguments) -> Result<SearchResult, &'static str> {
        arguments.validate()?;
        let mut body = serde_json::json!({
            "q": arguments.query,
            "count": 5,
            "maximum_number_of_urls": 5,
            "maximum_number_of_tokens": 2048,
            "safesearch": "moderate"
        });
        if let Some(freshness) = &arguments.freshness {
            body["freshness"] = Value::String(freshness.clone());
        }
        let mut response = self
            .client
            .post(&self.endpoint)
            .header("Accept", "application/json")
            .header("X-Subscription-Token", self.key.clone())
            .json(&body)
            .send()
            .await
            .map_err(|_| "Web search could not connect. Try again.")?;
        match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err("The web search credential or API access was rejected.");
            }
            StatusCode::TOO_MANY_REQUESTS => {
                return Err("Web search is busy or its quota is exhausted.")
            }
            status if !status.is_success() => return Err("Web search is temporarily unavailable."),
            _ => {}
        }
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Web search returned an unreadable result.")?
        {
            if data.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("Web search returned too much data.");
            }
            data.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&data)
            .map_err(|_| "Web search returned an unreadable result.")?;
        normalize(&arguments.query, &value)
    }
}

fn normalize(query: &str, value: &Value) -> Result<SearchResult, &'static str> {
    let items = value
        .pointer("/grounding/generic")
        .and_then(Value::as_array)
        .ok_or("Web search returned an unreadable result.")?;
    let mut result = SearchResult {
        query: query.to_owned(),
        sources: Vec::new(),
        error: None,
    };
    for item in items.iter().take(5) {
        let Some(raw_url) = item.get("url").and_then(Value::as_str) else {
            continue;
        };
        let Ok(url) = Url::parse(raw_url) else {
            continue;
        };
        if !matches!(url.scheme(), "https" | "http")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || raw_url.len() > 2048
        {
            continue;
        }
        let title = truncate_utf8(
            item.get("title")
                .and_then(Value::as_str)
                .unwrap_or("Source"),
            180,
        );
        let text = item
            .get("snippets")
            .and_then(Value::as_array)
            .map(|snippets| {
                snippets
                    .iter()
                    .filter_map(Value::as_str)
                    .take(3)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        result.sources.push(SearchSource {
            title,
            url: raw_url.to_owned(),
            text: truncate_utf8(&text, 1000),
        });
        while serde_json::to_vec(&result)
            .map_err(|_| "Could not prepare web search results.")?
            .len()
            > MAX_RESULT_BYTES
        {
            let Some(last) = result.sources.last_mut() else {
                break;
            };
            if last.text.len() > 100 {
                last.text = truncate_utf8(&last.text, last.text.len().saturating_sub(100));
            } else {
                result.sources.pop();
                break;
            }
        }
    }
    Ok(result)
}

fn truncate_utf8(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn validates_search_schema_and_caps_utf8_results() {
        assert!(SearchArguments {
            query: "latest Rust SDK documentation".to_owned(),
            freshness: Some("pw".to_owned())
        }
        .validate()
        .is_ok());
        assert!(SearchArguments {
            query: "a ".repeat(76),
            freshness: None
        }
        .validate()
        .is_err());
        assert!(SearchArguments {
            query: "news".to_owned(),
            freshness: Some("header\r\nvalue".to_owned())
        }
        .validate()
        .is_err());
        let value = serde_json::json!({"grounding":{"generic":(0..5).map(|index| serde_json::json!({
            "title":"🙂".repeat(80), "url":format!("https://example.com/{index}"), "snippets":["🌲".repeat(1000)]
        })).collect::<Vec<_>>()}});
        let result = normalize("Rust SDK", &value).unwrap();
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_RESULT_BYTES);
        assert_eq!(result.sources.len(), 5);
        assert!(result
            .sources
            .iter()
            .all(|source| source.text.len() <= 1000));
    }

    #[tokio::test]
    async fn local_tool_sends_the_key_only_as_a_header_and_sanitizes_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = vec![];
            let header_end = loop {
                let mut buffer = [0; 4096];
                let length = connection.read(&mut buffer).unwrap();
                assert_ne!(length, 0);
                data.extend_from_slice(&buffer[..length]);
                if let Some(index) = data.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8(data[..header_end].to_vec()).unwrap();
            assert!(headers.starts_with("POST /context HTTP/1.1"));
            assert!(headers
                .to_ascii_lowercase()
                .contains("x-subscription-token: test-secret-for-local-tool"));
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            while data.len() < header_end + length {
                let mut buffer = [0; 4096];
                let length = connection.read(&mut buffer).unwrap();
                assert_ne!(length, 0);
                data.extend_from_slice(&buffer[..length]);
            }
            let body = &data[header_end..header_end + length];
            assert!(!String::from_utf8_lossy(body).contains("test-secret-for-local-tool"));
            let json: Value = serde_json::from_slice(body).unwrap();
            assert_eq!(json["count"], 5);
            assert_eq!(json["maximum_number_of_tokens"], 2048);
            let response = "{\"private_provider_details\":\"test-secret-for-local-tool\"}";
            write!(
                connection,
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        });
        let tool = BraveSearch::for_test(
            "test-secret-for-local-tool",
            &format!("http://{address}/context"),
        );
        let result = tool
            .search(&SearchArguments {
                query: "Rust SDK docs".to_owned(),
                freshness: None,
            })
            .await;
        assert_eq!(
            result.error,
            Some("The web search credential or API access was rejected.")
        );
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("test-secret-for-local-tool"));
        server.join().unwrap();
    }
}

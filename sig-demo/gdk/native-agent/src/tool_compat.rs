// Copyright 2026 Sig Demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

//! A narrow fallback for mesh models that place a search call in assistant text.
//! Native GDK tool requests take precedence; this module never executes a tool.

use serde::Deserialize;

use crate::brave::{is_search_name, SearchArguments};

const OPEN: &str = "<tool_call>";
const CLOSE: &str = "</tool_call>";
const MAX_FRAME_BYTES: usize = 8 * 1024;
const MAX_FRAMES: usize = 8;
const INVALID_CALL: &str = "Sig returned an unreadable web search request. Try again.";
const UNSUPPORTED_CALL: &str = "Sig requested an unavailable tool. Only web search is available.";

#[derive(Debug)]
pub struct CompatToolCall {
    pub name: String,
    pub arguments_json: String,
}

struct Frame {
    bytes: String,
    total_bytes: usize,
    closing_probe: String,
    oversized: bool,
}

impl Frame {
    fn new() -> Self {
        Self {
            bytes: OPEN.to_owned(),
            total_bytes: OPEN.len(),
            closing_probe: String::new(),
            oversized: false,
        }
    }

    fn push(&mut self, character: char) -> bool {
        self.total_bytes = self.total_bytes.saturating_add(character.len_utf8());
        if self.total_bytes > MAX_FRAME_BYTES {
            self.oversized = true;
            self.bytes.clear();
        } else if !self.oversized {
            self.bytes.push(character);
        }
        self.closing_probe.push(character);
        while self.closing_probe.len() > CLOSE.len() {
            let first = self.closing_probe.chars().next().unwrap();
            self.closing_probe.drain(..first.len_utf8());
        }
        self.closing_probe == CLOSE
    }
}

/// Ordinary answers stream immediately, except a possible opening/closing tag
/// prefix (at most 11 ASCII bytes). Complete standalone control frames are held
/// separately, never emitted as chat text, and decoded only when the turn ends.
pub struct ToolTextFilter {
    pending: String,
    candidate_is_standalone: bool,
    frame: Option<Frame>,
    frames_seen: usize,
    calls: Vec<CompatToolCall>,
    error: Option<&'static str>,
    line_has_text: bool,
    leading_indent: usize,
    delimiter_character: Option<char>,
    delimiter_length: usize,
    delimiter_at_line_start: bool,
    fence: Option<(char, usize)>,
    pending_fence_close: bool,
    inline_delimiter_length: Option<usize>,
}

impl ToolTextFilter {
    pub fn new() -> Self {
        Self {
            pending: String::new(),
            candidate_is_standalone: false,
            frame: None,
            frames_seen: 0,
            calls: Vec::new(),
            error: None,
            line_has_text: false,
            leading_indent: 0,
            delimiter_character: None,
            delimiter_length: 0,
            delimiter_at_line_start: false,
            fence: None,
            pending_fence_close: false,
            inline_delimiter_length: None,
        }
    }

    pub fn push(&mut self, text: &str) -> String {
        let mut visible = String::new();
        for character in text.chars() {
            if let Some(frame) = self.frame.as_mut() {
                if frame.push(character) {
                    let frame = self.frame.take().unwrap();
                    if frame.oversized {
                        self.error.get_or_insert(INVALID_CALL);
                    } else {
                        match parse_frame(&frame.bytes) {
                            Ok(call) if self.calls.len() < MAX_FRAMES => self.calls.push(call),
                            Ok(_) => {
                                self.error.get_or_insert(INVALID_CALL);
                            }
                            Err(error) => {
                                self.error.get_or_insert(error);
                            }
                        }
                    }
                }
                continue;
            }

            if self.pending.is_empty() {
                self.candidate_is_standalone = self.is_standalone();
            }
            self.pending.push(character);
            loop {
                if self.pending == OPEN {
                    self.pending.clear();
                    if self.candidate_is_standalone {
                        self.frames_seen += 1;
                        if self.frames_seen > MAX_FRAMES {
                            self.error.get_or_insert(INVALID_CALL);
                        }
                        self.frame = Some(Frame::new());
                    } else {
                        // Literal inline tags and Markdown examples are prose,
                        // not another instruction to execute a local search.
                        self.emit_visible(OPEN, &mut visible);
                    }
                    break;
                }
                if self.pending == CLOSE {
                    self.pending.clear();
                    if self.candidate_is_standalone {
                        self.error.get_or_insert(INVALID_CALL);
                    } else {
                        self.emit_visible(CLOSE, &mut visible);
                    }
                    break;
                }
                if self.candidate_is_standalone
                    && (self.pending.starts_with("<tool_call")
                        && self.pending.len() > "<tool_call".len())
                {
                    // Attributes or a misspelled control opener are not an
                    // executable protocol. Hide the entire malformed frame.
                    self.error.get_or_insert(INVALID_CALL);
                    self.pending.clear();
                    self.frame = Some(Frame::new());
                    break;
                }
                if OPEN.starts_with(&self.pending) || CLOSE.starts_with(&self.pending) {
                    break;
                }
                let first = self.pending.chars().next().unwrap();
                self.pending.drain(..first.len_utf8());
                visible.push(first);
                self.note_visible(first);
                self.candidate_is_standalone = self.is_standalone();
                if self.pending.is_empty() {
                    break;
                }
            }
        }
        visible
    }

    /// Call after consuming the GDK stream. If native tool requests were received,
    /// the caller should prefer them and ignore compatibility calls/errors.
    pub fn finish(mut self) -> Result<(String, Vec<CompatToolCall>), &'static str> {
        if self.frame.is_some() {
            self.error.get_or_insert(INVALID_CALL);
        }
        let tail = if self.candidate_is_standalone
            && (self.pending.starts_with("<tool_") || self.pending.starts_with("</tool_"))
        {
            self.error.get_or_insert(INVALID_CALL);
            String::new()
        } else {
            self.pending
        };
        if let Some(error) = self.error {
            Err(error)
        } else {
            Ok((tail, self.calls))
        }
    }

    fn is_standalone(&self) -> bool {
        !self.line_has_text
            && self.leading_indent < 4
            && self.fence.is_none()
            && self.inline_delimiter_length.is_none()
    }

    fn emit_visible(&mut self, text: &str, visible: &mut String) {
        visible.push_str(text);
        for character in text.chars() {
            self.note_visible(character);
        }
    }

    fn note_visible(&mut self, character: char) {
        if matches!(character, '`' | '~') {
            if self.delimiter_character == Some(character) {
                self.delimiter_length = self.delimiter_length.saturating_add(1);
            } else {
                self.finish_delimiter();
                self.delimiter_character = Some(character);
                self.delimiter_length = 1;
                self.delimiter_at_line_start = !self.line_has_text && self.leading_indent < 4;
            }
        } else {
            self.finish_delimiter();
        }
        if self.pending_fence_close {
            if matches!(character, '\n' | '\r') {
                self.fence = None;
                self.pending_fence_close = false;
            } else if !matches!(character, ' ' | '\t') {
                // A closing fence may have whitespace, but no info string.
                self.pending_fence_close = false;
            }
        }
        if matches!(character, '\n' | '\r') {
            self.line_has_text = false;
            self.leading_indent = 0;
        } else if !self.line_has_text && matches!(character, ' ' | '\t') {
            self.leading_indent += if character == '\t' { 4 } else { 1 };
        } else {
            self.line_has_text = true;
        }
    }

    fn finish_delimiter(&mut self) {
        let Some(character) = self.delimiter_character.take() else {
            return;
        };
        if let Some((fence_character, fence_length)) = self.fence {
            if self.delimiter_at_line_start
                && character == fence_character
                && self.delimiter_length >= fence_length
            {
                self.pending_fence_close = true;
            }
        } else if let Some(inline_length) = self.inline_delimiter_length {
            if character == '`' && self.delimiter_length == inline_length {
                self.inline_delimiter_length = None;
            }
        } else if self.delimiter_at_line_start && self.delimiter_length >= 3 {
            self.fence = Some((character, self.delimiter_length));
        } else if character == '`' {
            self.inline_delimiter_length = Some(self.delimiter_length);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JsonCall {
    name: String,
    arguments: SearchArguments,
}

fn parse_frame(frame: &str) -> Result<CompatToolCall, &'static str> {
    let body = frame
        .strip_prefix(OPEN)
        .and_then(|value| value.strip_suffix(CLOSE))
        .ok_or(INVALID_CALL)?
        .trim();
    let (name, arguments) = if body.starts_with('{') {
        let call = serde_json::from_str::<JsonCall>(body).map_err(|_| INVALID_CALL)?;
        (call.name, call.arguments)
    } else {
        // The observed model output wraps google_search this way. This is an
        // exact string protocol, not a general XML parser or arbitrary tool API.
        let wrapped = body.strip_prefix("<function=").ok_or(INVALID_CALL)?;
        let (wrapper_name, wrapped) = wrapped.split_once('>').ok_or(INVALID_CALL)?;
        if !is_search_name(wrapper_name) {
            return Err(UNSUPPORTED_CALL);
        }
        let wrapped = wrapped
            .trim()
            .strip_suffix("</function>")
            .ok_or(INVALID_CALL)?
            .trim();
        let (name, rest) = take_element(wrapped, "<function_name>", "</function_name>")?;
        let (arguments, rest) =
            take_element(rest.trim(), "<function_arguments>", "</function_arguments>")?;
        if !rest.trim().is_empty() {
            return Err(INVALID_CALL);
        }
        (
            name.trim().to_owned(),
            serde_json::from_str::<SearchArguments>(arguments.trim()).map_err(|_| INVALID_CALL)?,
        )
    };
    if !is_search_name(&name) {
        return Err(UNSUPPORTED_CALL);
    }
    arguments.validate().map_err(|_| INVALID_CALL)?;
    Ok(CompatToolCall {
        name: "brave_web_search".to_owned(),
        arguments_json: serde_json::to_string(&arguments).map_err(|_| INVALID_CALL)?,
    })
}

fn take_element<'a>(
    value: &'a str,
    open: &str,
    close: &str,
) -> Result<(&'a str, &'a str), &'static str> {
    value
        .strip_prefix(open)
        .and_then(|value| value.split_once(close))
        .ok_or(INVALID_CALL)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OBSERVED: &str = "<tool_call>\n<function=search>\n<function_name>google_search</function_name>\n<function_arguments>{\"query\": \"movies playing in West Vancouver cinemas October 2026\"}</function_arguments>\n</function>\n</tool_call>";
    const CANONICAL: &str = "<tool_call>{\"name\":\"brave_web_search\",\"arguments\":{\"query\":\"Rust SDK\",\"freshness\":\"pm\"}}</tool_call>";

    #[test]
    fn observed_and_canonical_calls_never_leak_at_any_chunk_boundary() {
        for frame in [OBSERVED, CANONICAL] {
            for split in 0..=frame.len() {
                let mut filter = ToolTextFilter::new();
                assert!(filter.push(&frame[..split]).is_empty());
                assert!(filter.push(&frame[split..]).is_empty());
                let (tail, calls) = filter.finish().unwrap();
                assert!(tail.is_empty());
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "brave_web_search");
                let arguments: SearchArguments =
                    serde_json::from_str(&calls[0].arguments_json).unwrap();
                arguments.validate().unwrap();
            }
        }
    }

    #[test]
    fn ordinary_text_streams_without_waiting_for_the_turn_to_end() {
        let mut filter = ToolTextFilter::new();
        assert_eq!(filter.push("Hydrogen is "), "Hydrogen is ");
        assert_eq!(
            filter.push("the first element. 🙂"),
            "the first element. 🙂"
        );
        assert_eq!(filter.push(" Less than <"), " Less than ");
        assert_eq!(filter.push("3."), "<3.");
        let (tail, calls) = filter.finish().unwrap();
        assert!(tail.is_empty());
        assert!(calls.is_empty());
    }

    #[test]
    fn prelude_streams_and_adjacent_standalone_calls_remain_hidden() {
        let mut filter = ToolTextFilter::new();
        assert_eq!(
            filter.push("I'll check the web.\n"),
            "I'll check the web.\n"
        );
        assert!(filter.push(CANONICAL).is_empty());
        assert!(filter.push(OBSERVED).is_empty());
        let (_, calls) = filter.finish().unwrap();
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn quoted_markdown_and_ordinary_json_are_not_executable() {
        for literal in [
            format!("The tag `{CANONICAL}` is an example."),
            format!("```xml\n{CANONICAL}\n```\n"),
            format!("~~~xml\n{OBSERVED}\n~~~\n"),
            format!("> {CANONICAL}\n"),
            format!("    {CANONICAL}\n"),
            format!("An example: {CANONICAL}"),
            format!("````xml\n```\n{CANONICAL}\n````\n"),
            format!("```xml\n```not-a-closing-fence\n{CANONICAL}\n```\n"),
            format!("`multiline code\n{CANONICAL}\n`"),
            format!("``multiline code\n`\n{CANONICAL}\n``"),
            r#"{"name":"brave_web_search","arguments":{"query":"SDK"}}"#.to_owned(),
        ] {
            let mut filter = ToolTextFilter::new();
            let mut visible = String::new();
            for character in literal.chars() {
                visible.push_str(&filter.push(&character.to_string()));
            }
            let (tail, calls) = filter.finish().unwrap();
            visible.push_str(&tail);
            assert_eq!(visible, literal);
            assert!(calls.is_empty());
        }
    }

    #[test]
    fn unrecognized_or_malformed_standalone_calls_are_suppressed_and_rejected() {
        for frame in [
            r#"<tool_call>{"name":"shell","arguments":{"query":"SDK"}}</tool_call>"#,
            r#"<tool_call>{"name":"brave_web_search","arguments":{"query":"SDK","url":"https://example.com"}}</tool_call>"#,
            r#"<tool_call>{"name":"brave_web_search","arguments":{"query":"SDK"},"endpoint":"https://example.com"}</tool_call>"#,
            r#"<tool_call>{"name":"brave_web_search","arguments":{"query":"SDK","freshness":"forever"}}</tool_call>"#,
            r#"<tool_call>{"name":"brave_web_search","arguments":{"query":""}}</tool_call>"#,
            "<tool_call>unreadable</tool_call>",
            "<tool_call unexpected>unreadable</tool_call>",
            "<tool_call>{\"name\":\"brave_web_search\"}",
            "<tool_call",
        ] {
            let mut filter = ToolTextFilter::new();
            assert!(filter.push(frame).is_empty());
            assert!(filter.finish().is_err());
        }
    }

    #[test]
    fn aliases_can_only_request_the_same_bounded_brave_search() {
        for name in ["brave_web_search", "search", "web_search", "google_search"] {
            let frame = format!("<tool_call>{{\"name\":\"{name}\",\"arguments\":{{\"query\":\"SDK\"}}}}</tool_call>");
            let mut filter = ToolTextFilter::new();
            assert!(filter.push(&frame).is_empty());
            let (_, calls) = filter.finish().unwrap();
            assert_eq!(calls[0].name, "brave_web_search");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&calls[0].arguments_json).unwrap()
                    ["query"],
                "SDK"
            );
        }
        let wrapped_shell = OBSERVED.replace("<function=search>", "<function=shell>");
        let mut filter = ToolTextFilter::new();
        assert!(filter.push(&wrapped_shell).is_empty());
        assert!(filter.finish().is_err());
    }

    #[test]
    fn frame_memory_and_call_count_are_bounded() {
        let mut filter = ToolTextFilter::new();
        assert!(filter.push(OPEN).is_empty());
        assert!(filter.push(&"é".repeat(MAX_FRAME_BYTES)).is_empty());
        assert!(filter.frame.as_ref().unwrap().bytes.len() <= MAX_FRAME_BYTES);
        assert!(filter.frame.as_ref().unwrap().closing_probe.len() <= CLOSE.len());
        assert!(filter.push(CLOSE).is_empty());
        assert!(filter.finish().is_err());

        let mut filter = ToolTextFilter::new();
        for _ in 0..=MAX_FRAMES {
            assert!(filter.push(CANONICAL).is_empty());
        }
        assert!(filter.calls.len() <= MAX_FRAMES);
        assert!(filter.finish().is_err());
    }
}

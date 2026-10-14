Upstream: goose-provider-types 0.1.0-alpha.12, Apache-2.0.
Source: https://github.com/aaif-goose/goose/tree/4811ae25f736fdf0ede847449c060e96645426b5/crates/goose-provider-types

Sig Demo adds a narrow `web_search: true` model request parameter that enables the OpenAI Responses built-in web_search tool, permits its output items, and exposes HTTP(S) source citations after streamed answer text. Other provider behavior stays upstream. This parameter is a local compatibility patch, not an official Goose SDK API.

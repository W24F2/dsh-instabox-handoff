# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-12

### Added
- Initial implementation of the DeepSeek-to-InstaBox Agent Handoff protocol
- Cordis plugin for DeepSeek Harness with full conversation handoff capability
- `instabox_handoff` tool for initiating handoffs
- `instabox_status` tool for checking handoff state
- `instabox_reclaim` tool for returning control to DeepSeek
- CLI commands: `/handoff`, `/handoff-status`, `/reclaim`
- Three-phase handoff protocol: transfer → ingest → delegate
- Session state persistence with phases: idle → preparing → transferring → ingesting → awaiting_ack → delegated → reclaiming → reclaimed → failed
- Conversation routing with caching for idempotency
- Automatic failover and recovery on box failures
- Secure redaction of sensitive values before transfer (API keys, tokens, credentials)
- Event-based conversation streaming from InstaBox
- Support for image attachments
- Unit tests (39 tests) covering core modules
- Integration tests (4 tests) covering full handoff flow
- Live verification script for testing with real InstaBox instances

### Security
- Automatic detection and redaction of credential patterns (sk-*, AKIA*, ghp_*, etc.)
- Environment variable secrets redacted via literal matching
- Protocol-level verification of payload digests

### Known Limitations
- Only image attachments are fully supported
- Tool executions are not re-run inside the box
- Approval policy is opaque to the host
- Conversation import via file payload (not API)
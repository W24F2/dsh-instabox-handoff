# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-13

### Added
- **Chat memory transfer.** The handoff payload now carries the harness's durable
  memory tracks alongside the conversation transcript:
  - `memory.project` — the project memory log (`<memories>/projects/<sha1-12>/MEMORY.md`)
    for the handed-off working directory,
  - `memory.daily` — the most recent daily journal entries, newest first.
- `plugin/lib/core/memory.js` resolves the memory root from `DSH_HOME`/`~/.dsh`,
  reproduces the harness's project key (`sha1(abs path)` first 12 hex), and caps
  capture by count and bytes (`truncated` flag when over budget).
- `handoff.includeMemory`, `handoff.memoryDailyDays`, `handoff.maxMemoryBytes` config keys.
- Protocol validation for the optional `memory` section, and `memoryFileCount` in the
  box-side verifier acknowledgement.
- `/handoff` and `instabox_handoff` now describe themselves as sending chat memory,
  and `/handoff` reports how many memory files were transferred.
- Unit tests for memory capture (`tests/unit/memory.test.js`) and integration assertions
  that the verifier counted the memory files.

### Changed
- `Orchestrator` accepts an injectable `memoryReader` so tests can supply a deterministic
  capture; the default is `readChatMemory`.
- Package versions bumped to `0.2.0`.

### Fixed
- **`apply()` is now `async`.** It awaited `readFile` while declared as a synchronous
  function, so `plugin/lib/index.js` failed to parse with `SyntaxError: Unexpected
  reserved word` and the plugin could never load into a DSH profile. The entry point is
  now covered by `tests/unit/plugin-entry.test.js`, which also runs `apply()` against a
  stub context and asserts the registered tool and command names.

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
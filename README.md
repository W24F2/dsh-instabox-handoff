# InstaBox Bridge: DeepSeek-to-InstaBox Agent Handoff

A Cordis plugin for DeepSeek Harness that enables seamless handoff of active conversations to persistent InstaBox-hosted agents, with live bidirectional routing, control reclaim, recovery, and security.

## Overview

When a conversation needs long-term persistence, this plugin can:

1. **Handoff**: Serialize the current session state *and* its chat memory (project log + daily journal), transfer it to an InstaBox instance, and hand control to the box agent.
2. **Route**: Forward subsequent messages from the harness to the box agent for ongoing conversation.
3. **Reclaim**: Bring control back to DeepSeek when needed.
4. **Recover**: Resume an interrupted handoff or recover control after an instance restart.

## Installation

### Prerequisites
- DeepSeek Harness (DSH) with the Cordis plugin system
- InstaBox CLI installed and authenticated (`instabox whoami` should succeed)

### Plugin Installation

```bash
# Copy the plugin directory to your DSH profile
cp -r plugin ~/.dsh/profiles/web/

# Or use DSH's plugin manager (if available)
dsh plugin install instabox-bridge
```

### Configuration

Create a config file at `~/.dsh/profiles/web/cordis.cjson` or edit the profile configuration:

```json
{
  "instabox-bridge": {
    "enabled": true,
    "instance": {
      "mode": "connect",
      "name": "your-box-name",
      "org": "your-org"
    }
  }
}
```

Key configuration options:

| Option | Description | Default |
|--------|-------------|---------|
| `instance.mode` | `connect` to existing or `create` new box | `connect` |
| `instance.name` | Box name to use | (auto-generated if creating) |
| `boxSidecar.nodePath` | Path to Node.js for running the verifier | `node` |
| `handoff.ackTimeoutMs` | Timeout waiting for agent ACK | `120000` |
| `handoff.includeMemory` | Send the project memory log + daily journal | `true` |
| `handoff.memoryDailyDays` | How many daily journals to include | `7` |
| `handoff.maxMemoryBytes` | Cap on captured memory (truncates over budget) | `2097152` |
| `routing.turnTimeoutMs` | Timeout for receiving box turn | `600000` |

## Usage

### Handoff a Conversation

Use the built-in tool during an active conversation:

```
<handoff My user asked me to remember this important task>
```

Or use the tool definition:

```json
{
  "name": "instabox_handoff",
  "arguments": {
    "reason": "User requested persistent memory for task tracking"
  }
}
```

### Check Handoff Status

```
<instabox_status />
```

### Reclaim Control

```
<instabox_reclaim arguments={"reason": "User wants to continue in DeepSeek"} />
```

Or via command:

```
/reclaim "taking back control"
```

## Architecture

### What gets sent to the box

One payload (`payload.json`), verified in-box before the agent reads it:

| Section | Contents |
|---------|----------|
| `conversation` | Full transcript: messages, content blocks, tool calls and results, attachments |
| `memory.project` | Durable project memory log (`<memories>/projects/<key>/MEMORY.md`) for the handed-off cwd |
| `memory.daily` | Recent daily journal entries (`<memories>/daily/<YYYY-MM-DD>.md`), newest first |
| `task` / `execution` | Last user message, open tool calls, turn/step position, pending inbox |
| `instructions` | System prompt, agent config, user preferences (redacted) |
| `tools` / `permissions` | Tool schemas and the approval-policy note |
| `redactions` | Every redaction applied, by path and kind |

The project-memory key is the first 12 hex characters of the SHA-1 of the absolute
project path — the same scheme the harness uses, so the box reads the right log.

Memory capture is bounded by `handoff.memoryDailyDays` (default 7) and
`handoff.maxMemoryBytes` (default 2 MiB); over-budget files are truncated and the
payload records `truncated: true`.

### Protocol

The handoff uses a three-phase protocol:

1. **Transfer**: Serialize session events, chat memory, system prompt, agent state, and tools to `payload.json`, run a verifier inside the box to confirm integrity.

2. **Ingest**: Send an instruction to the box agent with an ACK marker. The agent reads the payload and replies with the marker when ingested.

3. **Delegate**: Once ACK is verified, the harness routes all future requests to the box agent via the `box:box-name` provider route.

### Event Flow

```
Harness → Handoff Tool → Serialize conversation + memory → Push Payload → Run Verifier → Agent Prompt → Wait for ACK → Delegate
```

During delegation:

```
User Message → Router → Box Agent → Event Stream → Extract Reply → Cache → Return to Harness
```

## Testing

```bash
# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration

# Run all tests
npm run test:all
```

## Live Verification

Before using with a real InstaBox, verify the setup:

```bash
INSTABOX_API_KEY=xxx npm run verify:live
```

This will test:
- CLI connectivity
- Box creation/connectivity
- Basic handoff round-trip

## Limitations

- Only image attachments are fully supported (durable attachments)
- Tool executions are not re-run inside the box - the box agent uses its own tools
- The approval policy is opaque to the host (handled by host UI)
- Conversation import is done via file payload, not API

## Security

Sensitive values are redacted before transfer:
- Environment variables matching known secret patterns (`sk-*`, `AKIA*`, etc.)
- Credential keys in configuration objects
- API keys and tokens

## Troubleshooting

| Issue | Check |
|-------|-------|
| Handoff fails | `instabox whoami`, `instabox ls` |
| Agent doesn't respond | Check box logs: `instabox logs <box>` |
| Reclaim doesn't work | Ensure no in-flight turn; use `instabox stop <box>` if needed |
| Messages not routed | Verify phase is `delegated`: `/handoff-status` |
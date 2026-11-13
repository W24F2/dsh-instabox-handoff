# DeepSeek-to-InstaBox Agent Handoff

> Hand off active conversations from DeepSeek Harness to persistent InstaBox-hosted agents with full context transfer, live bidirectional routing, and control reclaim.

[![npm version](https://badge.fury.io/js/dsh-instabox-handoff.svg)](https://badge.fury.io/js/dsh-instabox-handoff)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Quick Install

```bash
# Clone the repository
git clone https://github.com/W24F2/dsh-instabox-handoff.git
cd dsh-instabox-handoff

# Install plugin into your DSH profile
# Option 1: Copy to profile
cp -r plugin/ ~/.dsh/profiles/web/

# Option 2: Create symlink
ln -s $(pwd)/plugin ~/.dsh/profiles/web/dsh-plugin-instabox-bridge

# Option 3: Build and install
pnpm install
pnpm run build
```

## Features

- ✅ Sends the current chat memory: full transcript **plus** the durable project memory log and recent daily journal entries
- ✅ Full conversation handoff with context preservation
- ✅ Bidirectional message routing while delegated
- ✅ Control reclamation from InstaBox to DeepSeek
- ✅ Automatic failover on box failures
- ✅ Secure redaction of credentials and API keys
- ✅ Session persistence across restarts
- ✅ Testable with fake CLI for CI/CD

## Usage

### Handoff a Conversation

Using the tool during an active conversation:

```
<handoff reason="User needs persistent memory">
  My task: Remember to follow up with the client next Tuesday at 2 PM
</handoff>
```

Or via tool definition:

```json
{
  "name": "instabox_handoff",
  "arguments": {
    "reason": "Transferring to persistent agent"
  }
}
```

### Check Handoff Status

```
/instabox_status
```

or

```
<instabox_status />
```

Returns:
- Current phase (preparing, transferring, ingesting, awaiting_ack, delegated, reclaimed, etc.)
- Box name and connection status
- Conversation ID
- ACK details if available

### Reclaim Control

```
/instabox_reclaim "Taking back control"
```

or

```
<instabox_reclaim arguments={"reason": "User wants to continue in DeepSeek"}>
```

## Configuration

Configure the plugin in `~/.dsh/profiles/web/cordis.cjson`:

```json
{
  "instabox-bridge": {
    "enabled": true,
    "providerName": "instabox",
    "cli": {
      "program": "instabox",
      "argsPrefix": [],
      "timeoutMs": 120000,
      "runner": "pipe"
    },
    "instance": {
      "mode": "connect",
      "name": "my-persistent-box",
      "readyTimeoutMs": 300000
    },
    "handoff": {
      "ackTimeoutMs": 120000,
      "maxPayloadBytes": 33554432,
      "transferImages": true
    },
    "routing": {
      "turnTimeoutMs": 600000,
      "failoverOnError": true,
      "maxConsecutiveFailures": 2
    }
  }
}
```

## Protocol Overview

The handoff follows a three-phase protocol:

```
1. Transfer Phase
   ┌────────────────────────────────────────────────────┐
   │ DeepSeek → Serializes state → Pushes payload.json  │
   │          → Runs in-box verifier → Creates ack.json │
   └────────────────────────────────────────────────────┘

2. Ingest Phase
   ┌────────────────────────────────────────────────────┐
   │ Sends prompt with ACK marker to box agent          │
   │ Waits for agent to reply with:                     │
   │   [instabox-handoff:ack <handoffId> <digest12>]   │
   └────────────────────────────────────────────────────┘

3. Delegate Phase
   ┌────────────────────────────────────────────────────┐
   │ State: phase = "delegated"                         │
   │ Router: routes → box:providerName                  │
   │ Future: User messages → Box agent replies          │
   └────────────────────────────────────────────────────┘
```

## Directory Structure

```
plugin/
├── lib/                    # Core modules
│   ├── config.js          # Configuration normalization
│   ├── state.js           # Session state persistence
│   ├── client.js          # InstaBox CLI client
│   ├── router.js          # Message routing
│   ├── orchestrator.js    # Handoff state machine
│   └── adapter.js         # LlmAdapter implementation
├── box-side/
│   └── verify.mjs         # Payload integrity verification
├── lib/index.js           # Plugin entry point
└── cordis.patch.yml       # Bundle definition

tests/
├── unit/                  # Unit tests (39 tests)
├── integration/           # Integration tests (4 tests)
└── fixtures/              # Test utilities
```

## Development

### Prerequisites

- Node.js 22+
- pnpm 9+
- Git

### Setup

```bash
git clone https://github.com/W24F2/dsh-instabox-handoff.git
cd dsh-instabox-handoff
pnpm install
```

### Testing

```bash
# Run all tests
pnpm run test:all

# Unit tests only
pnpm run test:unit

# Integration tests only  
pnpm run test:integration
```

### Live Verification

```bash
# Requires InstaBox CLI and API key
INSTABOX_API_KEY=your-key npm run verify:live
```

## Architecture Details

### Session State Machine

```
idle ──handoff()──→ preparing ──push──→ transferring ──verify──→ ingesting ──prompt──→ awaiting_ack ──ack──→ delegated
   ↑                                                                                         │
   └─────────────────────────────────────────────────────────────────────────────────────────┘
                                                                                                   
reclaim()                                                                                           │
    ↓                                                                                               │
reclaiming ──────────────────────────────────────────────────────────→ reclaimed ───┬──┘

handoff() failure                                                                                   │
    ↓                                                                                               │
failed ────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `orchestrator.js` | Handoff state machine with 7 phases |
| `router.js` | Message routing with caching for idempotency |
| `client.js` | InstaBox CLI client with JSON wrappers |
| `adapter.js` | LlmAdapter duck-type for box routing |
| `state.js` | Atomic session state persistence |
| `redact.js` | Credential detection and redaction |

## Security

Sensitive values are automatically redacted:

- Environment variables: `sk-*`, `AKIA*`, `xox*`, `Bearer`, `credential =`
- Token patterns: `ghp_*`, `github_pat_*`, `ibk_*`
- In-line secrets in configurations

## Limitations

- Only image attachments (PNG, JPEG, GIF, WebP) are transferred
- Tool executions are not re-run inside the box
- The approval policy is opaque to the host UI
- Conversation import via file payload (not API)

## Troubleshooting

| Symptom | Solution |
|---------|----------|
| `Error: box not found` | Run `instabox ls` to list available boxes |
| `Error: instabox not found` | Install InstaBox CLI: `npm install -g @instabox/cli` |
| `handoff` hangs | Check `instabox logs <box>` for errors |
| Messages not routing | Verify phase is `delegated`: `/instabox_status` |
| `EMPTY_REPLY` | Check fake CLI's `agent events` output format |

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## Support

- Open an issue on GitHub
- Email: bridge@users.noreply.github.com
- docs: [README.md](README.md)
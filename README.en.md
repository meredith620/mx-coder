# mx-coder (Multi-modal Cross Coder)

An AI CLI session bridge for managing multiple AI CLI sessions with native terminal interaction and remote IM continuation.

中文版说明: [README.md](README.md)

## What problem does it solve?

Claude Code and similar AI CLIs work best in a terminal, but once you leave your computer, that workflow usually stops. mx-coder lets you continue the same session remotely through IM platforms such as Mattermost, then resume seamlessly from your terminal later.

## Key features

- **Native terminal experience**: `attach` enters Claude Code directly without adding a proxy UI
- **Resident IM worker per session**: each active session keeps a resident Claude process, and follow-up IM messages are sent to the same stdin
- **Terminal-first with takeover**: normal IM messages are rejected while the terminal owns the session, with takeover support when needed
- **Multiple sessions in parallel**: manage multiple independent sessions at once
- **Mattermost self-healing connection**: application-level liveness detection and active reconnect for WebSocket
- **Clear runtime semantics**: distinguishes `cold / ready / running / waiting_approval / attached_terminal` and related states
- **Pluggable architecture**: extensible across both IM platforms and coder CLIs

## Quick start

```bash
mx-coder start
mx-coder create bug-fix --workdir ~/myapp
mx-coder attach bug-fix
```

### Typical workflow

```bash
# Start the background daemon
mx-coder start

# Create a named session
mx-coder create bug-fix --workdir ~/myapp

# Work from terminal
mx-coder attach bug-fix

# Continue from IM
# `/open <name>` follows the configured Mattermost `spaceStrategy`:
# - thread: find or create a thread
# - channel: find or create a dedicated private channel via the main channel as index
# normal IM messages are rejected while attached, with takeover commands available

# Resume again from terminal
mx-coder attach bug-fix
```

## Shell completion

mx-coder supports:
- `mx-coder completion bash`
- `mx-coder completion zsh`
- `mx-coder completion sessions`

### Bash

Add this to `~/.bashrc`:

```bash
eval "$(mx-coder completion bash)"
```

Then run:

```bash
source ~/.bashrc
```

### Zsh

Add this to `~/.zshrc`:

```bash
eval "$(mx-coder completion zsh)"
```

Then run:

```bash
source ~/.zshrc
```

## Configuration

### Mattermost

Create `~/.mx-coder/config.json`:

```json
{
  "im": {
    "mattermost": {
      "url": "https://mattermost.example.com",
      "token": "your-bot-token",
      "channelId": "channel-id",
      "spaceStrategy": "thread",
      "reconnectIntervalMs": 5000
    }
  }
}
```

| Field | Description |
|------|------|
| `url` | Mattermost server URL |
| `token` | Bot Personal Access Token |
| `channelId` | Main channel ID to listen on |
| `spaceStrategy` | Session space strategy for new sessions: `thread` (default) or `channel` |
| `teamId` | Required when `spaceStrategy=channel`, used to create private channels |
| `reconnectIntervalMs` | WebSocket reconnect interval, default 5000ms |

## Documentation index

### User-facing docs

- [docs/SPEC.md](docs/SPEC.md) — current design spec and behavioral source of truth
- [docs/RESEARCH.mattermost-typing-semantics.md](docs/RESEARCH.mattermost-typing-semantics.md) — Mattermost typing semantics research

### Developer docs

- [docs/DEV-OPS.md](docs/DEV-OPS.md) — development, testing, packaging, and publishing
- [docs/CLAUDE-CODE-MCP-PERMISSION.md](docs/CLAUDE-CODE-MCP-PERMISSION.md) — Claude Code MCP permission protocol
- [docs/STATE-INVARIANTS.md](docs/STATE-INVARIANTS.md) — state invariants
- [docs/EVENT-SEMANTICS.md](docs/EVENT-SEMANTICS.md) — event semantics
- [docs/TODO.md](docs/TODO.md) — current unfinished work
- [docs/MATTERMOST-GAPS.md](docs/MATTERMOST-GAPS.md) — remaining Mattermost gaps
- [docs/IMPL-SLICES.md](docs/IMPL-SLICES.md) — current implementation slice entry
- [docs/IMPL-SLICES.phase3-future-features.md](docs/IMPL-SLICES.phase3-future-features.md) — phase3 planning

### Historical docs

- [docs/archive/](docs/archive/) — archived phase documents and historical materials

## Project status

The current mainline already includes the resident IM worker architecture, shell completion, TUI foundation, and the current planned scope of Mattermost thread/channel session-space support.

For remaining work, see [docs/TODO.md](docs/TODO.md).

## Acknowledgements

Thanks to [claude-threads](https://github.com/anneschuth/claude-threads), which strongly influenced this project’s product direction and architecture.

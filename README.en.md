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

## Command Reference

| Command | Description |
|---------|-------------|
| `mx-coder start` | Start daemon in background |
| `mx-coder start-fg` | Start daemon in foreground (prints logs) |
| `mx-coder stop` | Stop the running daemon |
| `mx-coder restart` | Restart the daemon |
| `mx-coder create <name> [-w <path>] [-C <cli>]` | Create a new session |
| `mx-coder attach <name>` | Attach to an existing session, enter Claude Code terminal |
| `mx-coder open <name>` | Open session in IM (one-shot space override) |
| `mx-coder env list <session>` | List all env vars for a session (values masked) |
| `mx-coder env get <session> <KEY>` | Get a specific env var value |
| `mx-coder env set <session> <KEY> <VALUE>` | Set an env var |
| `mx-coder env unset <session> <KEY>` | Remove an env var |
| `mx-coder env clear <session>` | Clear all env vars for a session |
| `mx-coder env import <session> <env-file>` | Bulk import env vars from a .env file |
| `mx-coder diagnose <name>` | Print local diagnostic info for a session |
| `mx-coder takeover-status <name>` | Show takeover request state |
| `mx-coder takeover-cancel <name>` | Cancel a pending takeover request |
| `mx-coder list` | List all sessions |
| `mx-coder status [name]` | Show daemon or session status |
| `mx-coder remove <name>` | Remove a session |
| `mx-coder import <sessionId> -w <path>` | Import external session from file |
| `mx-coder completion bash\|zsh\|sessions` | Print shell completion script or session list |
| `mx-coder im init [-p <plugin>] [-c <path>]` | Generate IM plugin config template |
| `mx-coder im verify [-p <plugin>] [-c <path>]` | Verify IM connectivity |
| `mx-coder im run <sessionName>` | Run IM worker for a session |
| `mx-coder tui` | Open interactive TUI dashboard |
| `mx-coder setup systemd [--user] [--dry-run]` | Preview/install/manage systemd user service |
| `mx-coder --help, -h` | Show this help |
| `mx-coder --version, -v` | Show version info |

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

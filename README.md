# ohbaby-agent

An AI coding assistant CLI tool inspired by opencode and gemini-cli.

## Features

- AI-powered coding assistance with multiple LLM providers
- Interactive CLI with Ink (React-based terminal UI)
- Tool execution system for file operations, shell commands, and more
- Session management with conversation history
- Memory system (OHBABY.md, compatible with CLAUDE.md and AGENTS.md) for project context
- MCP (Model Context Protocol) support (post-MVP extension)

## Prerequisites

- Node.js >= 24.0.0
- pnpm >= 9.0.0

## Installation

```bash
# Clone the repository
git clone https://github.com/diverHansun/ohbaby-agent.git
cd ohbaby-agent

# Install dependencies
pnpm install

# Copy environment file and configure secrets
cp .env.example .env
# Edit .env with your API keys

# Create ~/.ohbaby-agent/model.json for non-secret model settings
mkdir -p ~/.ohbaby-agent
cat > ~/.ohbaby-agent/model.json <<'JSON'
{
  "provider": "openai",
  "defaultModel": "gpt-4.1",
  "apiConfig": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "llmParams": {
    "temperature": 0.2,
    "maxTokens": 4096
  }
}
JSON
```

`model.json` stores provider/model/base URL/parameter settings. API keys stay in
environment variables. Put `OPENAI_API_KEY=...` in your shell or project `.env`;
shell variables take priority over `.env`.

## Development

```bash
# Start development server with hot reload
pnpm dev

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Type check
pnpm typecheck

# Lint
pnpm lint

# Format code
pnpm format

# Run all checks (before committing)
pnpm preflight

# Build for production
pnpm build
```

## Project Structure

```
ohbaby-agent/
├── src/
│   ├── index.ts              # Entry point
│   ├── cli/                   # CLI layer (Ink components)
│   │   ├── commands/          # Slash command handlers
│   │   └── ui/                # UI components
│   ├── commands/              # Business logic for commands
│   ├── core/                  # Core modules
│   │   ├── lifecycle/         # Execution loop
│   │   ├── message/           # Message management
│   │   ├── memory/            # OHBABY.md memory
│   │   └── tool-scheduler/    # Tool orchestration
│   ├── services/              # Service modules
│   │   └── session/           # Session management
│   ├── agents/                # Agent configurations
│   ├── tools/                 # Core tools
│   ├── policy/                # Mode and permission policies
│   ├── permission/            # User confirmation
│   ├── bus/                   # Event system
│   ├── config/                # Configuration
│   └── utils/                 # Utilities
├── docs/                      # Design documentation
└── tests/                     # Integration tests
```

## Documentation

See the `docs/` directory for detailed design documentation:

- [Coding Guide](./coding_guide.md) - Development guidelines
- [Module Documentation](./docs/) - Individual module designs

Agent-recognized memory entry files:
- `OHBABY.md` (canonical, highest priority)
- `AGENTS.md` (OpenAI Agents/Codex-compatible fallback)
- `CLAUDE.md` (Anthropic Claude-compatible fallback)

## License

MIT

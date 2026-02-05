# iris-code

An AI coding assistant CLI tool inspired by opencode and gemini-cli.

## Features

- AI-powered coding assistance with multiple LLM providers
- Interactive CLI with Ink (React-based terminal UI)
- Tool execution system for file operations, shell commands, and more
- Session management with conversation history
- Memory system (IRIS.md) for project context
- MCP (Model Context Protocol) support

## Prerequisites

- Node.js >= 20.0.0
- pnpm >= 9.0.0

## Installation

```bash
# Clone the repository
git clone https://github.com/iris-code/iris-code.git
cd iris-code

# Install dependencies
pnpm install

# Copy environment file and configure
cp .env.example .env
# Edit .env with your API keys
```

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
iris-code/
├── src/
│   ├── index.ts              # Entry point
│   ├── cli/                   # CLI layer (Ink components)
│   │   ├── commands/          # Slash command handlers
│   │   └── ui/                # UI components
│   ├── commands/              # Business logic for commands
│   ├── core/                  # Core modules
│   │   ├── lifecycle/         # Execution loop
│   │   ├── message/           # Message management
│   │   ├── memory/            # IRIS.md memory
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

## License

MIT

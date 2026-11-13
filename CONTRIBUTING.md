# Contributing to InstaBox Bridge

Thank you for your interest in contributing to InstaBox Bridge! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites
- Node.js 22 or later
- pnpm 9.x (or npm with `npm i -g pnpm`)
- DeepSeek Harness installed with Cordis plugin system

### Getting Started

```bash
# Clone the repository
git clone https://github.com/W24F2/dsh-instabox-handoff.git
cd dsh-instabox-handoff

# Install dependencies
pnpm install

# Run tests
pnpm run test:all
```

## Project Structure

```
├── plugin/                 # Cordis plugin package
│   ├── lib/               # Core module implementations
│   │   ├── config.js      # Configuration normalization
│   │   ├── state.js       # Session state persistence
│   │   ├── client.js      # InstaBox CLI client
│   │   ├── router.js      # Message routing logic
│   │   ├── orchestrator.js # Handoff state machine
│   │   └── ...
│   └── box-side/          # Files pushed to the InstaBox
│       └── verify.mjs     # Payload verification script
├── tests/
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   └── fixtures/          # Test fixtures
├── docs/                  # Documentation
└── scripts/               # Utility scripts
```

## Development Workflow

### Running Tests

```bash
# Unit tests only
pnpm run test:unit

# Integration tests only
pnpm run test:integration

# All tests
pnpm run test:all
```

### Code Style

We use standard JavaScript conventions:
- ES modules (`import`/`export`)
- JSDoc for type documentation
- 2-space indentation
- Trailing commas in multiline structures

### Linting

```bash
# Check for issues
npx eslint plugin/lib/**/*.js

# Fix auto-fixable issues
npx eslint plugin/lib/**/*.js --fix
```

## Pull Request Process

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** and write/update tests as needed.

3. **Ensure all tests pass**:
   ```bash
   pnpm run test:all
   ```

4. **Update documentation** if you've changed functionality:
   - Update README.md if user-facing
   - Update JSDoc comments in code
   - Add inline comments for complex logic

5. **Submit a pull request** with a clear description of changes.

### Pull Request Checklist

- [ ] Tests added or updated for new functionality
- [ ] All tests pass (`pnpm run test:all`)
- [ ] Documentation updated as needed
- [ ] Code follows the project's style conventions
- [ ] Commit messages are clear and descriptive

## Testing Locally with InstaBox

### Using the Fake CLI (Unit/Integration Tests)

Tests use a fake InstaBox CLI implementation that simulates the real CLI:

```bash
pnpm run test:integration
```

### Live Testing (Requires InstaBox Access)

1. Ensure `INSTABOX_API_KEY` is set
2. Run the verification script:
   ```bash
   npm run verify:live
   ```

3. Install the plugin in your DSH profile:
   ```bash
   # Copy plugin to profile
   cp -r plugin ~/.dsh/profiles/web/
   
   # Or use DSH CLI
   dsh --patch plugin/cordis.patch.yml
   ```

4. Restart DSH and verify:
   ```bash
   dsh --profile web --dump-config | grep instabox
   ```

## Reporting Issues

Please report bugs and feature requests via GitHub Issues. When reporting issues, please include:

1. Environment details (OS, Node version, DSH version)
2. Steps to reproduce
3. Expected behavior
4. Actual behavior (error messages, logs)
5. Any relevant configuration

## License

This project is provided under the MIT License. See LICENSE file for details.
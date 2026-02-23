# @danubedata/cli

Deploy static sites to [DanubeData](https://danubedata.ro) from the terminal.

## Installation

```bash
npm install -g @danubedata/cli
```

Requires Node.js 18 or later.

## Quick Start

```bash
# Authenticate with your API token
danube login

# Link your project to a static site
danube pages link

# Deploy the current directory
danube pages deploy
```

## Authentication

Generate an API token from your [DanubeData dashboard](https://danubedata.ro) and authenticate:

```bash
danube login
```

You can also pass the token directly:

```bash
danube login --token <your-token>
```

Or set the `DANUBE_TOKEN` environment variable for CI/CD:

```bash
export DANUBE_TOKEN=your-token
danube pages deploy
```

## Commands

### `danube login`

Authenticate with DanubeData. Prompts for an API token or accepts `--token <token>`.

### `danube logout`

Remove stored authentication credentials.

### `danube whoami`

Show the currently authenticated user and their teams.

### `danube pages link`

Link the current directory to a DanubeData static site. Prompts you to select a team and site (or create a new one). Writes configuration to `.danube/project.json`.

### `danube pages deploy`

Deploy your site to DanubeData.

```bash
danube pages deploy              # Deploy current directory
danube pages deploy --dir dist   # Deploy a specific directory
danube pages deploy --no-wait    # Don't wait for build to complete
```

The command packages your files into a ZIP archive, uploads them, and polls the build status until deployment is live.

### `danube pages deployments ls`

List all deployments for the linked site. Shows revision, status, trigger method, and timestamps.

### `danube pages deployments rollback <revision>`

Activate a previous deployment by revision number.

```bash
danube pages deployments rollback 3
```

### `danube pages domains ls`

List all domains configured for the linked site.

### `danube pages domains add <domain>`

Add a custom domain. Returns DNS verification instructions if required.

### `danube pages domains remove <domain>`

Remove a custom domain.

### `danube pages domains verify <domain>`

Trigger DNS verification for a custom domain.

## Configuration

### Project Configuration

Running `danube pages link` creates a `.danube/project.json` file in your project directory. This file is required for all `pages` subcommands.

### `danube.json`

You can optionally create a `danube.json` file in your project root to configure deployments:

```json
{
  "outputDir": "dist",
  "ignore": ["*.map", "test/**"]
}
```

- **`outputDir`** - Directory to deploy (overridden by `--dir` flag)
- **`ignore`** - Additional file patterns to exclude from deployment

Files matching `.gitignore` patterns are automatically excluded, along with `.git`, `node_modules`, and `.danube` directories.

## Environment Variables

| Variable | Description |
|---|---|
| `DANUBE_TOKEN` | API token (alternative to `danube login`) |
| `DANUBE_API_BASE` | Override the API base URL |
| `CI` | Suppresses update notifications |
| `DANUBE_NO_UPDATE_CHECK` | Suppresses update notifications |

## License

MIT

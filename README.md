# @danubedata/cli

Manage [DanubeData](https://danubedata.ro) infrastructure from the terminal.

## Installation

```bash
npm install -g @danubedata/cli
```

Requires Node.js 18 or later.

## Quick Start

```bash
# Authenticate via browser
danube auth

# List your VPS instances
danube vps ls

# List your storage buckets
danube storage buckets ls

# Deploy a static site
danube pages link
danube pages deploy
```

## Authentication

### Browser Auth (recommended)

```bash
danube auth
```

Opens your browser to log in and authorize the CLI automatically — no manual token copying.

### Token Auth

```bash
danube login                    # Interactive prompt
danube login --token <token>    # Pass token directly
```

### CI/CD

```bash
export DANUBE_TOKEN=your-token
danube pages deploy
```

## Commands

### General

| Command | Description |
|---|---|
| `danube auth` | Authenticate via browser (like `gh auth login`) |
| `danube login` | Authenticate with an API token |
| `danube logout` | Remove stored credentials |
| `danube whoami` | Show authenticated user and teams |

### VPS Instances (`danube vps`)

| Command | Description |
|---|---|
| `danube vps ls` | List all VPS instances |
| `danube vps create` | Create a new VPS (interactive or flags) |
| `danube vps get <id>` | Show VPS details and connection info |
| `danube vps update <id>` | Update VPS config (must be stopped) |
| `danube vps delete <id>` | Delete a VPS instance |
| `danube vps start <id>` | Start a stopped VPS |
| `danube vps stop <id>` | Stop a running VPS |
| `danube vps reboot <id>` | Reboot a running VPS |
| `danube vps reinstall <id>` | Reinstall OS (destroys all data) |
| `danube vps status <id>` | Show current status and capabilities |
| `danube vps metrics <id>` | Show CPU/memory/storage/network usage |
| `danube vps password <id>` | Show SSH password (with confirmation) |
| `danube vps images` | List available OS images |

#### Create a VPS

```bash
# Interactive
danube vps create

# With flags
danube vps create \
  --name my-server \
  --image ubuntu-24.04 \
  --plan nano_shared \
  --ssh-key-id <key-id>
```

#### Power management

```bash
danube vps stop <id>
danube vps start <id>
danube vps reboot <id>
```

### Object Storage (`danube storage`)

| Command | Description |
|---|---|
| `danube storage buckets ls` | List all buckets |
| `danube storage buckets create` | Create a new bucket |
| `danube storage buckets get <id>` | Show bucket details |
| `danube storage buckets update <id>` | Update bucket settings |
| `danube storage buckets delete <id>` | Delete a bucket |
| `danube storage buckets metrics <id>` | Show bucket metrics |
| `danube storage keys ls` | List all access keys |
| `danube storage keys create` | Create a new access key |
| `danube storage keys get <id>` | Show access key details |
| `danube storage keys revoke <id>` | Revoke an access key |

#### Create a bucket

```bash
# Interactive
danube storage buckets create

# With flags
danube storage buckets create --name my-bucket --region fsn1 --versioning
```

#### Update bucket settings

```bash
danube storage buckets update <id> --size-limit 10GB --encryption
danube storage buckets update <id> --public --display-name "My Assets"
```

#### Manage access keys

```bash
danube storage keys create --name "deploy-key"
danube storage keys ls
danube storage keys revoke <id>
```

### Static Sites (`danube pages`)

| Command | Description |
|---|---|
| `danube pages link` | Link directory to a static site |
| `danube pages deploy` | Deploy the linked site |
| `danube pages deployments ls` | List deployments |
| `danube pages deployments rollback <rev>` | Roll back to a revision |
| `danube pages domains ls` | List custom domains |
| `danube pages domains add <domain>` | Add a custom domain |
| `danube pages domains remove <domain>` | Remove a custom domain |
| `danube pages domains verify <domain>` | Verify DNS for a domain |

#### Deploy

```bash
danube pages deploy              # Deploy current directory
danube pages deploy --dir dist   # Deploy a specific directory
danube pages deploy --no-wait    # Don't wait for build
```

## Configuration

### `danube.json`

Optional project config for static site deployments:

```json
{
  "outputDir": "dist",
  "ignore": ["*.map", "test/**"]
}
```

## Environment Variables

| Variable | Description |
|---|---|
| `DANUBE_TOKEN` | API token (alternative to `danube auth`) |
| `DANUBE_API_BASE` | Override the API base URL |
| `CI` | Suppresses update notifications |
| `DANUBE_NO_UPDATE_CHECK` | Suppresses update notifications |

## License

MIT

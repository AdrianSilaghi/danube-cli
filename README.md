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

## Scripting & JSON mode

Pass `--json` (any position) for machine-readable output. In JSON mode the CLI never prompts:
missing required flags fail with `{"code":"missing_required_flag","flags":[...]}` (exit 2) and
destructive commands require `--force`/`--yes` or fail with `{"code":"confirmation_required"}` (exit 5).
Errors are single-line JSON on stderr; results are JSON on stdout. (A few inline flag-value
validation errors still print plain text; they always exit non-zero.) List commands return the
complete collection (all pages).

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic or API error |
| 2 | Missing required flag (non-interactive) |
| 3 | Not authenticated |
| 4 | Resource not found |
| 5 | Confirmation required (add `--force`) |
| 130 | Cancelled (Ctrl+C) |

## Commands

`show` and `delete` remain accepted aliases of `get` and `rm` everywhere.

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
| `danube vps get <name-or-id>` | Show VPS details and connection info |
| `danube vps update <name-or-id>` | Update VPS config (must be stopped) |
| `danube vps rm <name-or-id>` | Delete a VPS instance |
| `danube vps start <name-or-id>` | Start a stopped VPS |
| `danube vps stop <name-or-id>` | Stop a running VPS |
| `danube vps reboot <name-or-id>` | Reboot a running VPS |
| `danube vps reinstall <name-or-id>` | Reinstall OS (destroys all data) |
| `danube vps status <name-or-id>` | Show current status and capabilities |
| `danube vps metrics <name-or-id>` | Show CPU/memory/storage/network usage |
| `danube vps password <name-or-id>` | Show SSH password (with confirmation) |
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

Plans and prices in the interactive picker are fetched live from the API.

#### Power management

```bash
danube vps stop <name-or-id>
danube vps start <name-or-id>
danube vps reboot <name-or-id>
```

### Object Storage (`danube storage`)

| Command | Description |
|---|---|
| `danube storage buckets ls` | List all buckets |
| `danube storage buckets create` | Create a new bucket |
| `danube storage buckets get <name-or-id>` | Show bucket details |
| `danube storage buckets update <name-or-id>` | Update bucket settings |
| `danube storage buckets rm <name-or-id>` | Delete a bucket |
| `danube storage buckets metrics <name-or-id>` | Show bucket metrics |
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
danube storage buckets update <name-or-id> --size-limit 10GB --encryption
danube storage buckets update <name-or-id> --public --display-name "My Assets"
```

#### Manage access keys

```bash
danube storage keys create --name "deploy-key"
danube storage keys ls
danube storage keys revoke <id>
```

### Cache Instances (`danube cache`)

Managed Redis / Valkey / Dragonfly in-memory stores.

| Command | Description |
|---|---|
| `danube cache ls` | List all cache instances |
| `danube cache create` | Create a new cache (interactive or flags) |
| `danube cache get <name-or-id>` | Show cache details |
| `danube cache update <name-or-id>` | Update resource profile or name |
| `danube cache rm <name-or-id>` | Delete a cache instance |
| `danube cache start <name-or-id>` | Start a stopped cache |
| `danube cache stop <name-or-id>` | Stop a running cache |
| `danube cache connection-info <name-or-id>` | Show connection URL and password |
| `danube cache metrics <name-or-id>` | Show memory, connections, hit ratio, and health |
| `danube cache dns enable <name-or-id>` | Enable public DNS |
| `danube cache dns disable <name-or-id>` | Disable public DNS |
| `danube cache snapshots ls` | List snapshots (optional `--instance <name-or-id>`) |
| `danube cache snapshots create <name-or-id> --name <name>` | Create a snapshot |
| `danube cache snapshots restore <snapshot-id>` | Restore into source instance |
| `danube cache snapshots clone <snapshot-id> --name <new>` | Clone into a new instance |
| `danube cache snapshots rm <snapshot-id>` | Delete a snapshot |

#### Create a cache

```bash
# Interactive
danube cache create

# With flags
danube cache create --name my-cache --provider redis --datacenter fsn1 --profile small
```

Plans and prices in the interactive picker are fetched live from the API.

### Database Instances (`danube database` / `danube db`)

Managed MySQL / PostgreSQL / MariaDB with read-replica support.

| Command | Description |
|---|---|
| `danube database ls` | List all database instances |
| `danube database create` | Create a new database (interactive or flags) |
| `danube database get <name-or-id>` | Show database details |
| `danube database update <name-or-id>` | Update resource profile or name |
| `danube database rm <name-or-id>` | Delete a database instance |
| `danube database start <name-or-id>` | Start a stopped database |
| `danube database stop <name-or-id>` | Stop a running database |
| `danube database credentials <name-or-id>` | Show connection URL, username, and password |
| `danube database metrics <name-or-id>` | Show memory, connections, query throughput, and health |
| `danube database dns enable <name-or-id>` | Enable public DNS |
| `danube database dns disable <name-or-id>` | Disable public DNS |
| `danube database replicas ls <name-or-id>` | List read replicas |
| `danube database replicas add <name-or-id> --count <n>` | Add one or more replicas |
| `danube database replicas rm <name-or-id> <index>` | Remove replica by index |
| `danube database replicas status <name-or-id>` | Show per-replica replication lag |
| `danube database snapshots ls` | List snapshots (optional `--instance <name-or-id>`) |
| `danube database snapshots create <name-or-id> --name <name>` | Create a snapshot |
| `danube database snapshots restore <snapshot-id>` | Restore into source instance |
| `danube database snapshots clone <snapshot-id> --name <new> [--database-name <db>]` | Clone into a new instance |
| `danube database snapshots rm <snapshot-id>` | Delete a snapshot |

#### Create a database

```bash
# Interactive
danube database create

# With flags
danube database create --name my-db --provider postgresql --datacenter fsn1 --profile small --database-name app
```

Plans and prices in the interactive picker are fetched live from the API.

### Parameter Groups (`danube parameter-groups` / `danube pg`)

Reusable engine configurations for cache / database / queue instances. System groups are read-only — clone them to customize.

| Command | Description |
|---|---|
| `danube pg ls [--type cache\|database\|queue] [--provider <p>]` | List groups (team + system) |
| `danube pg create --name <n> --type <t> --provider <p> --parameters <json\|@file.json> [--locked key1,key2]` | Create a new group |
| `danube pg get <id>` | Show group with parameters (locked keys highlighted) |
| `danube pg update <id> [--name] [--parameters ...] [--locked ...] [--default\|--no-default]` | Update team-owned group |
| `danube pg rm <id>` | Delete team-owned group (fails if in use) |
| `danube pg clone <id> [--name <new>]` | Clone into your team (typical for system groups) |

#### Create from a JSON file

```bash
# redis.json: { "maxmemory-policy": "allkeys-lru", "timeout": 0 }
danube pg create \
  --name my-redis \
  --type cache --provider redis \
  --parameters @redis.json \
  --locked maxmemory-policy
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

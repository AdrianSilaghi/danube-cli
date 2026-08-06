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
missing required flags fail with `missing_required_flag` (exit 2) and destructive commands require
`--force`/`--yes` or fail with `confirmation_required` (exit 5). List commands return the complete
collection (all pages).

**Every `--json` invocation emits one envelope, on stdout, success or failure:**

```json
{"success": true, "data": {...}, "error": null, "meta": {}}
{"success": false, "data": null, "error": {"code": "not_found", "message": "..."}, "meta": {}}
```

Check `success`; read `data`. Lists carry `meta.count`. Errors are in the envelope on **stdout**
rather than as bare JSON on stderr, so a caller capturing only stdout no longer gets an empty
string on failure and has to infer the reason from the exit code.

### Selecting a project

`--project <id>` (any position) scopes a single invocation, and is inherited by
every command:

```bash
danube --project 42 rapids get my-api --json
danube project select --project 42          # persists the default, no prompt
```

Precedence is explicit flag, then `DANUBE_TEAM_ID`, then the saved selection,
then the account default. A flag applies to **one invocation** and never
mutates saved config, so a script iterating over projects leaves nothing behind
for the next process. `--team` is accepted as an alias; supplying both with
different values is a usage error rather than a silent preference.

### Structured API failures

In JSON mode an API failure keeps its existing `{"code":"api_error",...}` shape
and adds a `cause` object carrying the backend's failure code, the resource it
concerns, and whether a retry can help:

```json
{"code":"api_error","status":503,"message":"...",
 "cause":{"code":"serverless.image_pull_auth","retryable":false,
          "resource":{"kind":"Revision","name":"my-api-00007"}}}
```

Check `cause.retryable` before retrying — a rejected registry credential will
never clear on its own.

### Agent workflow

The deploy path, each step answering before the next can waste time on it:

```bash
danube registry verify-push safi4/danube-todo --json      # may I push here?
danube rapids preflight --image cr.danubedata.ro/safi4/danube-todo:v1.0.0 --json
danube rapids apply --name danube-todo --image ... --wait --idempotency-key "$KEY" --json
danube rapids probe danube-todo --path /healthz --cold --warm-requests 5 --json
danube rapids diagnose danube-todo --json                 # only if something looks wrong
```

`preflight` resolves the digest and the image's architectures and reports whether a pull can
succeed at all — a missing tag or an arm64-only image otherwise surfaces as a revision stuck in
`ContainerMissing` minutes later, naming neither. `can_pull: null` means the image lives in a
registry DanubeData cannot read; that is *unknown*, not a failure, and does not exit non-zero.

### Operations

Create, deploy and redeploy return before the work is done, so they hand back an operation:

```bash
danube operations wait <operation-id> --timeout 30m --json
danube operations inspect <operation-id> --json
```

**`terminal` is the stop condition.** Do not infer it from `state`: a state you do not recognise
must be treated as still running. `wait` honours the server's `poll_after_ms`, and reports a
timeout as `operation.wait_timeout` — the operation has not failed, it has not finished. The id of
the resource works as well as the operation id, because for the first seconds after a create the
operation row does not exist yet.

`probe` reaches the URL from outside the platform and reports DNS, TLS (issuer and days to
expiry), status, upstream service time, and warm-vs-first latency. A plain-HTTP URL reports
`tls.negotiated: null` — **not** a TLS failure: internal Knative URLs are HTTP by design and
public TLS terminates at the edge proxy. `cold_start_likely` is an inference from the warm
median, and is `null` without `--warm-requests`, because nothing can force a scale-to-zero first.

### Freshness

`stale` on a status is narrower than "this data is old": it is true only when an **in-flight**
operation has gone unconfirmed for 15 minutes. A settled state never goes stale, so `stale: false`
alongside an old `observed_at` is correct — an error established an hour ago is still an error.

### Unknown commands

A command that does not exist exits **2** and names the alternatives, at any
depth and whether or not `--help` follows it:

```json
{"code":"unknown_command","message":"unknown command 'probe' for 'danube rapids'",
 "command":"probe","parent":"rapids","known_commands":["apply","create",...],
 "retryable":false}
```

Probing for a command is therefore safe: `danube rapids probe --help` reports
the command as missing rather than printing the parent's help and exiting 0.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic or API error, **or a diagnose that found a fatal problem** |
| 2 | Missing required flag (non-interactive), or a usage error such as an unknown command, a conflicting selector, or a non-integer project id |
| 3 | Not authenticated |
| 4 | Resource not found |
| 5 | Confirmation required (add `--force`) |
| 8 | Bucket metrics stale or unavailable |
| 130 | Cancelled (Ctrl+C) |

`diagnose` commands follow the platform contract: `success` in the `--json`
envelope reports the **call**, not the verdict. A diagnosis that ran correctly
and found a fatal problem is `success: true` with **exit code 1** — branch on
the exit code, or on `findings[].severity`, never on `success`.

> **Changed in 1.0.** `rapids diagnose --json` previously reported
> `success: false` when it found a fatal problem, so a working diagnosis looked
> like a failed command and disagreed with `preflight`. If you branch on
> `success`, switch to the exit code.


## Commands

`show` and `delete` remain accepted aliases of `get` and `rm` everywhere.

### General

| Command | Description |
|---|---|
| `danube auth` | Authenticate via browser (like `gh auth login`) |
| `danube login` | Authenticate with an API token |
| `danube logout` | Remove stored credentials |
| `danube whoami` | Show authenticated user and teams |
| `danube operations inspect <id>` | Show the state of a long-running operation |
| `danube operations wait <id>` | Block until an operation is terminal (`--timeout 30m`) |
| `danube upgrade` | Update the CLI (`--check` to see what would happen) |
| `danube config get` | Show CLI settings |
| `danube config set auto-update <true\|false>` | Toggle automatic same-major updates |

#### Staying up to date

After an interactive command the CLI checks npm at most once a day and prints a
notice on **stderr**. It never runs during `--json`, when stderr is not a TTY,
when `CI` is set, or when `DANUBE_NO_UPDATE_CHECK` is set — so scripts and
agents are never nudged and never change version underneath a pipeline.

`danube upgrade` installs the update. Prefer it over `npm install -g`: it
detects how the CLI was installed, and under a version manager (volta/asdf/fnm)
or against a directory it cannot write it refuses **before** running npm and
names the command that will work — rather than failing partway through and
leaving a half-written install.

`danube config set auto-update true` opts in to having same-major updates
installed for you. **A major upgrade is never installed automatically**,
however this is set: it is announced as breaking and left for you to run,
because a major renames codes and changes semantics. For pre-1.0 versions each
minor counts as a major, per semver.

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

### Rapids Containers (`danube rapids`)

Knative-based serverless containers with scale-to-zero.

| Command | Description |
|---|---|
| `danube rapids ls` | List serverless containers |
| `danube rapids get <name-or-id>` | Show serverless container details |
| `danube rapids create` | Create a new serverless container |
| `danube rapids deploy <name-or-id>` | Deploy a serverless container from local directory |
| `danube rapids redeploy <name-or-id>` | Redeploy a container with its current image (rolls out a new zero-downtime revision) |
| `danube rapids update <name-or-id>` | Update a serverless container |
| `danube rapids rm <name-or-id>` | Delete a serverless container |
| `danube rapids deployments <name-or-id>` | List deployments for a serverless container |
| `danube rapids usage <name-or-id>` | Show usage and billing for a serverless container |
| `danube rapids logs <name-or-id>` | Fetch container logs (`--since 1h`, `--level error`, `--container user-container`, `--cursor`) |
| `danube rapids revisions <name-or-id>` | List Knative revisions with their conditions, plus Service and Route readiness |
| `danube rapids events <name-or-id>` | Curated platform events for the container's service, revisions and pods |
| `danube rapids diagnose <name-or-id>` | Correlate status, revisions, events and logs into ranked findings with remediation |
| `danube rapids apply` | Create-or-update idempotently (`--wait`, `--idempotency-key`) |
| `danube rapids probe [name]` | Reach the public URL from outside: DNS, TLS, status, cold vs warm latency |
| `danube rapids preflight --image <ref>` | Check namespace, credential, manifest, digest and architecture before deploying |

Diagnostics notes:

- `logs` and `events` require a token with the `serverless:diagnostics`
  ability; `revisions` needs only `serverless:read`.
- In `--json` mode these emit the API envelope verbatim, so `data.available`,
  `meta.next_cursor` and `meta.retention_days` reach the caller. **An empty
  `data.entries` with `available: true` means the container printed nothing;
  `available: false` means the log store did not answer** — the two are not the
  same answer, and only the second is worth retrying.
- Revision conditions are tri-state: `Unknown` means the rollout is still in
  progress, not that it failed.
- Always pass `--since` to `logs`; without it the query covers only the last
  30 minutes.

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

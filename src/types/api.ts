export interface User {
  id: number;
  name: string;
  email: string;
}

export interface Team {
  id: number;
  name: string;
  personal_team: boolean;
  /**
   * Registry path segment for this team: `cr.danubedata.ro/{registry_namespace}/...`,
   * and the Kubernetes tenant slug.
   *
   * NOT derivable from `name` — a team called "Safi" can own the namespace
   * `safi4`, because the slug is uniquified when assigned. Guessing it produces
   * an opaque authorization failure from the registry.
   *
   * Optional because older deployments do not return it yet.
   */
  registry_namespace?: string;
}

export interface TeamsResponse {
  data: Team[] | Record<string, Team>;
  current_team_id: number;
}

export function teamsArray(res: TeamsResponse): Team[] {
  return Array.isArray(res.data) ? res.data : Object.values(res.data);
}

export interface StaticSite {
  id: number;
  team_id: number;
  name: string;
  slug: string;
  url: string;
  output_directory: string | null;
  status: string;
  current_deployment_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface StaticSiteBuild {
  id: string;
  build_number: number;
  status: 'pending' | 'processing' | 'building_image' | 'pushing' | 'succeeded' | 'failed' | 'cancelled';
  source_type: string;
  trigger_type: string;
  file_count: number | null;
  source_size_bytes: number | null;
  duration_seconds: number | null;
  error_message: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface StaticSiteDeployment {
  id: number;
  revision_number: number;
  status: 'pending' | 'building' | 'deploying' | 'active' | 'failed' | 'inactive';
  image_ref: string | null;
  trigger_type: string;
  is_current: boolean;
  file_count: number | null;
  file_size_bytes: number | null;
  build_duration_seconds: number | null;
  commit_sha: string | null;
  commit_message: string | null;
  deployed_at: string | null;
  created_at: string;
}

export interface StaticSiteDomain {
  id: number;
  static_site_id: number;
  domain: string;
  type: 'default' | 'custom';
  status: 'pending' | 'active' | 'failed';
  verification_record: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Pagination {
  current_page: number;
  last_page: number;
  per_page: number;
  total: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface MessageResponse {
  message: string;
}

export interface MessageWithDataResponse<T> {
  message: string;
  data: T;
}

export interface DeployResponse {
  message: string;
  site_id: number;
  status: string;
}

export interface StorageBucket {
  id: string;
  team_id: number;
  name: string;
  minio_bucket_name: string | null;
  region: string;
  status: string;
  endpoint: string | null;
  public_access: boolean;
  versioning_enabled: boolean;
  encryption_enabled: boolean;
  size_bytes: number | null;
  object_count: number | null;
  size_limit_bytes: number | null;
  monthly_cost_cents: number | null;
  monthly_cost_dollars: number;
  created_at: string;
  updated_at: string;
}

export interface StorageAccessKey {
  id: string;
  team_id: number;
  name: string;
  access_key_id: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAccessKeyResponse {
  id: string;
  name: string;
  access_key_id: string;
  secret_access_key: string;
  expires_at: string | null;
  message: string;
}

export interface StorageMetrics {
  size_bytes: number;
  size_human: string;
  object_count: number;
  requests_24h: number | null;
  requests_24h_by_method: {
    GET: number;
    PUT: number;
    DELETE: number;
    HEAD: number;
  } | null;
  requests_24h_by_status?: { '2xx': number; '4xx': number; '5xx': number } | null;
  error_rate_24h?: number | null;
  latency_24h_ms?: { p50: number | null; p95: number | null; mean: number | null } | null;
  egress_bytes_24h: number;
  egress_human_24h: string;
  ingress_bytes_24h?: number | null;
  ingress_human_24h?: string | null;
  monthly_cost_cents: number;
  monthly_cost_dollars: string;
  freshness?: 'fresh' | 'lagging' | 'stale' | 'never';
  last_sync_at: string | null;
  metrics_precomputed_at?: string | null;
}

export interface BucketTrendPoint {
  recorded_at: string;
  size_bytes: number;
  object_count: number;
  requests: { total: number | null; get: number; put: number; delete: number; head: number };
  status: { '2xx': number; '4xx': number; '5xx': number };
  egress_bytes: number;
  ingress_bytes: number | null;
  error_rate: number | null;
  latency_ms: { mean: number | null; p95?: number | null; p95_upper_bound?: number | null };
  interval_seconds: number | null;
  // Legacy backwards-compat field from the pre-deltas trend response.
  // Present when source==='legacy'; null when reading from the rollup table.
  requests_24h_total?: number | null;
}

export interface BucketTrendResponse {
  bucket_id: string;
  window: '24h' | '7d' | '30d';
  resolution: '1m' | '5m' | '1h' | '1d';
  source: 'deltas' | 'legacy';
  freshness: 'fresh' | 'lagging' | 'stale' | 'never';
  generated_at: string;
  data: BucketTrendPoint[];
}

export interface BucketTopObjectsResponse {
  bucket_id: string;
  dimension: 'size' | 'egress' | 'requests';
  recorded_at: string | null;
  items: Array<{ rank: number; object_key: string; value: number }>;
}

export interface BucketHealthResponse {
  bucket_id: string;
  pending_multipart_count: number | null;
  pending_multipart_bytes: number | null;
  deleted_size_bytes: number | null;
  freshness: 'fresh' | 'lagging' | 'stale' | 'never';
  metrics_precomputed_at: string | null;
  last_health_check_at: string | null;
  health_check_status: 'ok' | 'skipped' | 'error' | null;
}

export interface VpsInstance {
  id: string;
  name: string;
  status: string;
  status_label: string;
  resource_profile: string;
  cpu_allocation_type: 'shared' | 'dedicated';
  cpu_cores: number;
  memory_size_gb: number;
  storage_size_gb: number;
  image: string;
  datacenter: string;
  public_ip: string | null;
  ipv6_address: string | null;
  vnc_access_url: string | null;
  monthly_cost_cents: number;
  monthly_cost_dollars: number;
  deployed_at: string | null;
  created_at: string;
  updated_at: string;
  team_id: number;
  user_id: number;
  ssh_key_id: number | null;
  can_be_started: boolean;
  can_be_stopped: boolean;
  can_be_rebooted: boolean;
  can_be_destroyed: boolean;
}

export interface VpsConnectionInfo {
  public_ip: string | null;
  private_ip: string | null;
  ipv6_address: string | null;
  vnc_access_url: string | null;
  internal_dns: string | null;
  internal_fqdn: string | null;
}

export interface VpsStatus {
  status: string;
  status_label: string;
  status_color: string;
  can_be_started: boolean;
  can_be_stopped: boolean;
  can_be_rebooted: boolean;
  can_be_destroyed: boolean;
  is_transitional: boolean;
  updated_at: string;
}

export interface VpsMetrics {
  cpu: { usage_percent: number; cores: number; sockets: number; threads: number };
  memory: { used_gb: number; total_gb: number; usage_percent: number };
  storage: { used_gb: number; total_gb: number; usage_percent: number };
  network: { rx_bytes_per_sec: number; tx_bytes_per_sec: number; error_rate: number; status: string };
  uptime_seconds: number;
  timestamp: string;
}

export interface VpsImage {
  id: string;
  image: string;
  label: string;
  description: string;
  distro: string;
  version: string;
  family: string | null;
  default_user: string;
}

export interface VpsImageGroup {
  distro: string;
  name: string;
  images: VpsImage[];
}

export interface PlansResponse<T> {
  plans: T[];
}

export interface VpsPlanInfo {
  slug: string;
  display_name: string;
  type: 'shared' | 'dedicated';
  cpu_cores: number;
  memory_gb: number;
  storage_gb: number;
  monthly_cost: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export type CacheProvider = 'redis' | 'valkey' | 'dragonfly';

export interface CacheInstance {
  id: string;
  name: string;
  status: string;
  status_label: string;
  resource_profile: string | null;
  cpu_cores: number;
  memory_size_mb: number;
  version: string | null;
  provider_id: number;
  provider?: { id: number; name: string; type: CacheProvider };
  endpoint: string | null;
  port: number | null;
  monthly_cost_cents: number;
  monthly_cost_dollars: string | number;
  deployed_at: string | null;
  created_at: string;
  updated_at: string;
  team_id: number;
  user_id: number;
  can_be_started: boolean;
  can_be_stopped: boolean;
  can_be_destroyed: boolean;
}

export interface CacheConnectionInfo {
  connection_info: string;
  password: string;
}

export interface CacheSnapshot {
  id: string;
  name: string;
  description: string | null;
  status: string;
  size_mb: number | null;
  cache_instance_id: string;
  cache_instance?: { id: string; name: string };
  created_at: string;
  updated_at: string;
}

export interface CachePlanInfo {
  slug: string;
  display_name: string;
  provider: string;
  cpu_cores: number;
  memory_mb: number;
  storage_gb: number;
  monthly_cost: number;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export type DatabaseProvider = 'mysql' | 'postgresql' | 'mariadb';

export interface DatabaseInstance {
  id: string;
  name: string;
  status: string;
  status_label: string;
  resource_profile: string;
  cpu_cores: number;
  memory_size_mb: number;
  storage_size_gb: number;
  version: string | null;
  datacenter: string | null;
  provider_id: number;
  provider?: { id: number; name: string; type: DatabaseProvider };
  engine?: { id: number; name: DatabaseProvider };
  endpoint: string | null;
  port: number | null;
  username: string | null;
  monthly_cost_cents: number;
  monthly_cost_dollars: string | number;
  deployed_at: string | null;
  created_at: string;
  updated_at: string;
  team_id: number;
  user_id: number;
  can_be_started: boolean;
  can_be_stopped: boolean;
  can_be_destroyed: boolean;
}

export interface DatabaseCredentials {
  connection_info: string;
  username: string;
  password: string;
}

export interface DatabaseReplica {
  name: string;
  node_id: string;
  replica_index: number;
  endpoint: string | null;
  status: string;
  ready: boolean;
  replication_status: string | null;
  seconds_behind_master: number | null;
  is_replication_healthy: boolean;
}

export interface DatabaseReplicaList {
  replicas: DatabaseReplica[];
  master: {
    name: string;
    node_id: string;
    endpoint: string | null;
    status: string;
    ready: boolean;
  };
  billing: {
    hourly_cost_cents: number;
    monthly_cost_cents: number;
  };
}

export interface DatabaseReplicationStatus {
  is_replicating: boolean;
  replica_count: number;
  replicas: Array<{
    name: string;
    node_id: string;
    ready: boolean;
    status: string;
    replication_status: string | null;
    seconds_behind_master: number | null;
    is_replication_healthy: boolean;
    replica_index: number;
  }>;
}

export interface DatabaseSnapshot {
  id: string;
  name: string;
  description: string | null;
  status: string;
  size_gb: number | null;
  database_instance_id: string;
  database_instance?: { id: string; name: string };
  created_at: string;
  updated_at: string;
}

export interface DatabasePlanInfo {
  slug: string;
  display_name: string;
  cpu_cores: number;
  memory_mb: number;
  storage_gb: number;
  monthly_cost: number;
}

// ---------------------------------------------------------------------------
// Metrics (cache / database summary)
// ---------------------------------------------------------------------------

export interface CacheMetricsSummary {
  memory_used_bytes: number;
  memory_used_mb: number;
  connected_clients: number;
  total_commands_processed: number;
  keyspace_hits: number;
  keyspace_misses: number;
  hit_ratio_percentage: number;
  retrieved_at: string;
}

export interface CacheHealth {
  is_healthy: boolean;
  up_status: boolean;
  redis_up: boolean;
  checked_at: string;
}

export interface CacheMetricsResponse {
  summary: CacheMetricsSummary;
  health: CacheHealth;
  instance: { id: string; name: string };
}

export interface DatabaseMetricsSummary {
  memory_used_bytes: number;
  memory_used_mb: number;
  connected_clients: number;
  total_queries: number;
  slow_queries: number;
  retrieved_at: string;
}

export interface DatabaseHealth {
  is_healthy: boolean;
  up_status: boolean;
  checked_at: string;
}

export interface DatabaseMetricsResponse {
  summary: DatabaseMetricsSummary;
  health: DatabaseHealth;
  instance: { id: string; name: string };
}

// ---------------------------------------------------------------------------
// Parameter groups
// ---------------------------------------------------------------------------

export type ParameterGroupType = 'cache' | 'database' | 'queue';

export interface ParameterGroup {
  id: number;
  name: string;
  type: ParameterGroupType;
  provider_type: string;
  family: string | null;
  description: string | null;
  parameters: Record<string, string | number | boolean | null>;
  locked_parameters: string[];
  team_id: number | null;
  is_default: boolean;
  is_active: boolean;
  is_system: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ServerlessContainer {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  deployment_type: 'docker_image' | 'git_repository' | 'zip_upload';
  source_type: string | null;
  image: string | null;
  image_tag: string;
  port: number;
  resource_profile: string;
  /**
   * The requests/limits actually applied to the pods, as Kubernetes
   * quantities (`1000m`, `512Mi`). Columns since the original table; what
   * changed in danubedata#409 is that they are now truly applied and worth
   * showing. Render these, never a client-side profile catalog — profiles
   * change server-side and these columns are the truth.
   */
  cpu_request: string;
  cpu_limit: string;
  memory_request: string;
  memory_limit: string;
  min_scale: number;
  max_scale: number;
  scaling_metric: 'rps' | 'concurrency' | null;
  scaling_target: number | null;
  concurrency_target: number | null;
  timeout_seconds: number | null;
  environment_variables: Record<string, string> | null;
  current_replicas: number;
  status: string;
  /**
   * The truthful state. Prefer this over `status`: it is the same object the
   * dashboard and the websocket broadcast use, so they cannot disagree.
   *
   * Optional because deployments predating danubedata 1059f32b typed it as a
   * bare string in the spec.
   */
  status_details?: ServerlessStatusDetails;
  /** Revision currently receiving traffic. Changes when a new one goes live. */
  current_revision?: string | null;
  /** Monotonic count of deployments. Changes as soon as a new one is recorded. */
  deployment_count?: number;
  url: string | null;
  created_at: string;
  updated_at: string;
}

/** @see https://docs.danubedata.ro/rapids-automation */
/**
 * The cross-product status contract.
 *
 * Every non-serverless product now returns this exact shape. Structurally
 * identical to ServerlessStatusDetails, which is frozen for wire-compat and
 * therefore kept separate rather than aliased.
 */
export interface StatusDetails {
  summary: 'pending' | 'in_progress' | 'ready' | 'degraded' | 'failed' | 'stopped' | 'deleting' | 'unknown';
  /** What is CURRENTLY true of the resource. `unknown` is not a failure. */
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** When the platform last CONFIRMED this, not when the row was written. */
  observed_at: string | null;
  /** Nobody has confirmed the state recently; treat `summary` as last-known. */
  stale: boolean;
  operation: {
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    /** THE stop condition for polling. Never infer this from `summary`. */
    terminal: boolean;
  };
  error: {
    /** Stable automation key, e.g. `uptime.dns`. Branch on this, not prose. */
    code: string;
    source: string | null;
    resource: { kind: string | null; name: string | null } | null;
    reason: string | null;
    message: string | null;
    /** Retrying a `false` here only consumes quota. */
    retryable: boolean;
    observed_at: string | null;
  } | null;
}

export interface ServerlessStatusDetails {
  summary: 'pending' | 'in_progress' | 'ready' | 'degraded' | 'failed' | 'stopped' | 'deleting' | 'unknown';
  /** What is CURRENTLY SERVING. `unknown` during a rollout is not a failure. */
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** When the platform last checked the cluster — not when the row was written. */
  observed_at: string | null;
  /** A live source could not be reached; `summary` is the last known one. */
  stale: boolean;
  operation: {
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    /** THE stop condition for polling. Never infer this from `summary`. */
    terminal: boolean;
  };
  error: {
    /** Stable automation key, e.g. `serverless.image_pull_auth`. */
    code: string;
    source: string | null;
    resource: { kind: string | null; name: string | null } | null;
    reason: string | null;
    message: string | null;
    /** Retrying a `false` here only consumes quota. */
    retryable: boolean;
    observed_at: string | null;
  } | null;
}

export interface ServerlessDeployment {
  id: string;
  revision_number: number;
  status: string;
  is_current: boolean;
  image: string;
  image_tag: string;
  traffic_percent: number;
  deployed_at: string | null;
  created_at: string;
}

export interface ServerlessBuild {
  id: string;
  build_number: number;
  status: 'pending' | 'cloning' | 'building' | 'pushing' | 'succeeded' | 'failed' | 'cancelled';
  source_type: string;
  trigger_type: string;
  built_image_ref: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  created_at: string;
}

export interface ServerlessShowResponse {
  container: ServerlessContainer;
  metrics: Record<string, unknown>;
  url: string | null;
  monthly_cost: number;
}

export interface ServerlessCreateResponse {
  message: string;
  container: ServerlessContainer;
}

export interface ServerlessDeployResponse {
  message: string;
  container_id: string;
  status: string;
}

export interface ServerlessUsageResponse {
  period: string;
  usage: unknown[];
  summary: {
    total_requests: number;
    total_compute_seconds: number;
    total_cost_cents: number;
    total_cost_dollars: number;
  };
}

/**
 * One series behind a console graph.
 *
 * `timestamps` are PRE-FORMATTED display strings — the platform formats them
 * by window (`H:i` up to 6h, `M d H:i` up to 72h, `M d` beyond). Never parse
 * them as dates. `values` are rounded to 2 decimals server-side.
 */
export interface MetricSeries {
  timestamps: string[];
  values: number[];
}

/** Series the platform emits today. Units: cpu in CORES, memory in BYTES,
 * latency in ms, requests in req/s, errors in percent. */
export type MetricSeriesKey = 'requests' | 'latency' | 'replicas' | 'cpu' | 'memory' | 'errors';

export interface ServerlessMetricsCurrent {
  current_pods?: number;
  /** Cores, not millicores. */
  current_cpu?: number;
  /** Bytes. */
  current_memory?: number;
  request_count_5m?: number;
}

/**
 * `GET /serverless/{id}/metrics` — bare payload, no {success,data} envelope.
 *
 * A series key is ABSENT entirely when Prometheus has no data for it, and
 * because the controller builds `metrics`/`current` as PHP arrays, both
 * serialize as `[]` rather than `{}` when empty — hence the array unions.
 * Normalize with Array.isArray before reading.
 */
export interface ServerlessMetricsResponse {
  container: { id: string; name: string; status: string; resource_profile: string };
  resources: {
    cpu_request: string;
    cpu_limit: string;
    memory_request: string;
    memory_limit: string;
  };
  period_hours: number;
  metrics: Partial<Record<MetricSeriesKey, MetricSeries>> | unknown[];
  current: ServerlessMetricsCurrent | unknown[];
}

/**
 * An uptime check.
 *
 * `status_details.health` describes the TARGET being watched, not the check
 * itself — a check whose site is down is working correctly, which is why the
 * API reduces `down` to degraded/unhealthy rather than failed.
 */
export interface UptimeCheck {
  id: string;
  name: string;
  url: string;
  method: string;
  status: 'up' | 'down' | 'paused' | 'unknown';
  status_details?: StatusDetails;
  capabilities?: { logs: boolean; events: boolean; diagnose: boolean };
  enabled: boolean;
  interval_seconds: number;
  timeout_seconds: number;
  expected_status: string;
  body_keyword: string | null;
  follow_redirects: boolean;
  verify_tls: boolean;
  check_ssl_expiry: boolean;
  ssl_expiry_threshold_days: number | null;
  ssl_expires_at: string | null;
  failure_threshold: number;
  notify_on_recovery: boolean;
  notification_channels: string[] | null;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_status_code: number | null;
  last_response_time_ms: number | null;
  /** A stable probe error CODE (dns, timeout, tls, refused, …), not prose. */
  last_error: string | null;
  team_id: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface UptimeCheckResponse {
  message: string;
  check: UptimeCheck;
}

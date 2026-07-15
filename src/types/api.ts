export interface User {
  id: number;
  name: string;
  email: string;
}

export interface Team {
  id: number;
  name: string;
  personal_team: boolean;
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
  size_bytes: number;
  object_count: number;
  size_limit_bytes: number | null;
  monthly_cost_cents: number;
  monthly_cost_dollars: string;
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
  min_scale: number;
  max_scale: number;
  scaling_metric: 'rps' | 'concurrency' | null;
  scaling_target: number | null;
  concurrency_target: number | null;
  timeout_seconds: number | null;
  environment_variables: Record<string, string> | null;
  current_replicas: number;
  status: string;
  url: string | null;
  created_at: string;
  updated_at: string;
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

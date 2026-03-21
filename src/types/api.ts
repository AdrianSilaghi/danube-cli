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
  data: Team[];
  current_team_id: number;
}

export interface StaticSite {
  id: number;
  team_id: number;
  name: string;
  slug: string;
  default_domain: string;
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
  object_count: number;
  monthly_cost_cents: number;
  monthly_cost_dollars: string;
  last_synced_at: string | null;
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
  team_id: string;
  user_id: string;
  ssh_key_id: string | null;
  can_be_started: boolean;
  can_be_stopped: boolean;
  can_be_rebooted: boolean;
  can_be_destroyed: boolean;
}

export interface VpsConnectionInfo {
  ssh_user: string;
  ssh_port: number;
  public_ip: string | null;
  ipv6_address: string | null;
  vnc_url: string | null;
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
  network: { rx_bytes: number; tx_bytes: number; rx_packets: number; tx_packets: number };
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

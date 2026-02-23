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

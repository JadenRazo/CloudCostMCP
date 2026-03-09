export interface CacheEntry {
  key: string;
  data: string; // JSON serialized
  provider: string;
  service: string;
  region: string;
  created_at: string;
  expires_at: string;
}

export interface CacheStats {
  total_entries: number;
  expired_entries: number;
  size_bytes: number;
}

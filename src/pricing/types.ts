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

export interface PricePoint {
  price_per_unit: number;
  unit: string;
  currency: string;
  pricing_source: string | null;
  recorded_at: string;
}

export interface PriceChange {
  current_price: number;
  previous_price: number;
  change_amount: number;
  change_percent: number;
  current_date: string;
  previous_date: string;
}

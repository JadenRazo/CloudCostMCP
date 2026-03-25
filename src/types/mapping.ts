import type { CloudProvider } from "./resources.js";

export interface ResourceEquivalent {
  category: string;
  aws: string;
  azure: string;
  gcp: string;
  notes?: string;
}

export interface InstanceMapping {
  source_type: string;
  source_provider: CloudProvider;
  target_type: string;
  target_provider: CloudProvider;
  vcpu_match: boolean;
  memory_match: boolean;
  category_match: boolean;
  match_score: number;
}

export interface RegionMapping {
  aws: string;
  azure: string;
  gcp: string;
  display_name: string;
}

export interface StorageMapping {
  category: string;
  aws: string;
  azure: string;
  gcp: string;
  iops_baseline?: number;
  throughput_mbps?: number;
}

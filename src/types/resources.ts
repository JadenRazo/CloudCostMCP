export type CloudProvider = "aws" | "azure" | "gcp";

export interface ParsedResource {
  id: string;
  type: string;
  name: string;
  provider: CloudProvider;
  region: string;
  attributes: ResourceAttributes;
  tags: Record<string, string>;
  source_file: string;
  source_line?: number;
}

export interface ResourceAttributes {
  instance_type?: string;
  vm_size?: string;
  machine_type?: string;
  storage_type?: string;
  storage_size_gb?: number;
  iops?: number;
  throughput_mbps?: number;
  engine?: string;
  engine_version?: string;
  multi_az?: boolean;
  replicas?: number;
  node_count?: number;
  min_node_count?: number;
  max_node_count?: number;
  os?: string;
  tier?: string;
  sku?: string;
  [key: string]: unknown;
}

export interface InstanceSpec {
  provider: CloudProvider;
  instance_type: string;
  vcpus: number;
  memory_gb: number;
  category: string;
  gpu_count?: number;
  gpu_type?: string;
  network_performance?: string;
  storage_type?: string;
}

export interface ResourceInventory {
  provider: CloudProvider;
  region: string;
  resources: ParsedResource[];
  total_count: number;
  by_type: Record<string, number>;
  parse_warnings: string[];
}

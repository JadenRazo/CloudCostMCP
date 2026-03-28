// ---------------------------------------------------------------------------
// Terraform State JSON types
//
// Represents the contents of a `.tfstate` file produced by Terraform.
// ---------------------------------------------------------------------------

export interface TerraformState {
  version: number;
  terraform_version: string;
  serial: number;
  lineage: string;
  resources: StateResourceBlock[];
}

export interface StateResourceBlock {
  mode: "managed" | "data";
  type: string;
  name: string;
  provider: string;
  instances: StateInstance[];
}

export interface StateInstance {
  attributes: Record<string, unknown>;
  index_key?: string | number;
}

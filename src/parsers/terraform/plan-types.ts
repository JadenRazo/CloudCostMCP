// ---------------------------------------------------------------------------
// Terraform Plan JSON types
//
// Represents the output of `terraform show -json <planfile>` or the JSON
// stream produced by `terraform plan -json`.
// ---------------------------------------------------------------------------

export interface TerraformPlan {
  format_version: string;
  terraform_version: string;
  resource_changes: ResourceChange[];
  prior_state?: PriorState;
}

export interface ResourceChange {
  address: string;
  type: string;
  name: string;
  provider_name: string;
  change: Change;
}

export interface Change {
  actions: ChangeAction[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  after_unknown?: Record<string, unknown>;
}

export type ChangeAction = "create" | "read" | "update" | "delete" | "no-op";

export interface PriorState {
  format_version?: string;
  values?: {
    root_module?: {
      resources?: StateResource[];
    };
  };
}

export interface StateResource {
  address: string;
  type: string;
  name: string;
  provider_name: string;
  values: Record<string, unknown>;
}

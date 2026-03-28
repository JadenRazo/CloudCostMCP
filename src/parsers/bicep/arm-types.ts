export interface ArmTemplate {
  $schema?: string;
  contentVersion?: string;
  parameters?: Record<string, ArmParameter>;
  variables?: Record<string, unknown>;
  resources: ArmResource[];
  outputs?: Record<string, unknown>;
}

export interface ArmParameter {
  type: string;
  defaultValue?: unknown;
  allowedValues?: unknown[];
  metadata?: { description?: string };
}

export interface ArmResource {
  type: string;
  apiVersion: string;
  name: string;
  location?: string;
  properties?: Record<string, unknown>;
  sku?: { name?: string; tier?: string; capacity?: number };
  kind?: string;
  dependsOn?: string[];
  tags?: Record<string, string>;
}

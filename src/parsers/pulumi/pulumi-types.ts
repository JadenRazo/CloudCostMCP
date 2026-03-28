export interface PulumiStackExport {
  version: number;
  deployment: {
    manifest: Record<string, unknown>;
    resources: PulumiResource[];
  };
}

export interface PulumiResource {
  urn: string;
  type: string;
  id?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  parent?: string;
}

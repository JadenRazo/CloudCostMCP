export interface CloudFormationTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Parameters?: Record<string, CfnParameter>;
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, unknown>;
}

export interface CfnParameter {
  Type: string;
  Default?: unknown;
  Description?: string;
  AllowedValues?: unknown[];
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  Condition?: string;
}

import { logger } from "../logger.js";

/**
 * Collect variable defaults from parsed HCL JSON and merge in any overrides
 * supplied via a .tfvars file. The resulting map is a flat key->value record
 * ready for substitution into attribute strings.
 *
 * HCL JSON structure for variables:
 *   { variable: { "name": [{ default: <value>, type: "string" }] } }
 */
export function resolveVariables(
  hclJson: Record<string, unknown>,
  tfvarsContent?: string
): Record<string, unknown> {
  const defaults = extractVariableDefaults(hclJson);
  const overrides = tfvarsContent ? parseTfvars(tfvarsContent) : {};

  const resolved = { ...defaults, ...overrides };

  logger.debug("Resolved variables", {
    defaultCount: Object.keys(defaults).length,
    overrideCount: Object.keys(overrides).length,
  });

  return resolved;
}

/**
 * Walk the `variable` block in parsed HCL JSON and build a map of
 * variable name -> default value for any variable that declares one.
 */
function extractVariableDefaults(
  hclJson: Record<string, unknown>
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  const variableBlock = hclJson["variable"];
  if (!variableBlock || typeof variableBlock !== "object") {
    return defaults;
  }

  // Structure: { "var_name": [{ default: value, type: "...", description: "..." }] }
  for (const [varName, declarations] of Object.entries(
    variableBlock as Record<string, unknown>
  )) {
    if (!Array.isArray(declarations) || declarations.length === 0) continue;

    const declaration = declarations[0] as Record<string, unknown>;
    if ("default" in declaration) {
      defaults[varName] = declaration["default"];
    }
  }

  return defaults;
}

/**
 * Parse a .tfvars file into a key->value map. Supports both simple
 * `key = value` assignments and quoted string values. Lines beginning with
 * `#` are treated as comments and skipped. Multi-line HCL constructs such as
 * heredocs are not supported; only scalar and simple list/map literals that
 * fit on a single line are handled.
 */
function parseTfvars(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Skip blank lines and comments
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1).trim();

    if (!key) continue;

    result[key] = parseTfvarsValue(rawValue);
  }

  return result;
}

/**
 * Convert a raw .tfvars value string into the appropriate JS primitive.
 * Handles quoted strings, booleans, null, and numeric literals.
 */
function parseTfvarsValue(raw: string): unknown {
  // Quoted string
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Null
  if (raw === "null") return null;

  // Numeric – try integer first, then float
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);

  // Unquoted string (e.g. bare region name without quotes in older tfvars)
  return raw;
}

/**
 * Recursively walk an attribute value tree and replace any `${var.xxx}`
 * interpolation patterns with the resolved variable value. Non-string leaves
 * are passed through unchanged.
 *
 * Terraform's HCL-to-JSON output wraps bare `var.x` references as
 * `"${var.x}"` in string contexts. We also handle the case where the entire
 * string is a variable reference and the variable's default is a non-string
 * type (e.g. number), in which case we return the typed value directly.
 */
export function substituteVariables(
  value: unknown,
  variables: Record<string, unknown>
): unknown {
  if (typeof value === "string") {
    return substituteInString(value, variables);
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteVariables(item, variables));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteVariables(v, variables);
    }
    return result;
  }

  return value;
}

const VAR_ONLY_RE = /^\$\{var\.([^}]+)\}$/;
const VAR_INLINE_RE = /\$\{var\.([^}]+)\}/g;

function substituteInString(
  str: string,
  variables: Record<string, unknown>
): unknown {
  // Whole-string variable reference – preserve the original type
  const wholeMatch = VAR_ONLY_RE.exec(str);
  if (wholeMatch) {
    const varName = wholeMatch[1];
    return varName in variables ? variables[varName] : str;
  }

  // Inline interpolation – always produces a string result
  return str.replace(VAR_INLINE_RE, (_match, varName: string) => {
    if (varName in variables) {
      const v = variables[varName];
      return v === null ? "" : String(v);
    }
    return _match;
  });
}

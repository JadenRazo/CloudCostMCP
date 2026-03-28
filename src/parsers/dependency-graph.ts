import type { ParsedResource } from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencyNode {
  id: string;
  type: string;
  provider: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  relationship: "reference" | "depends_on" | "implicit";
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

// ---------------------------------------------------------------------------
// Reference scanning
// ---------------------------------------------------------------------------

/**
 * Pattern to detect Terraform resource references of the form
 * `<resource_type>.<resource_name>` optionally followed by `.attribute` chains.
 *
 * The pattern anchors on word boundaries to avoid false positives inside
 * longer strings (e.g. variable names or ARN-like values).
 *
 * Capture groups:
 *   1 – resource type  (e.g. "aws_instance")
 *   2 – resource name  (e.g. "web")
 */
const REFERENCE_PATTERN =
  /\b([a-z][a-z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_-]*)(?:\.[a-zA-Z][a-zA-Z0-9_]*)*\b/g;

/**
 * Recursively walk an unknown value and collect all strings found anywhere
 * within it (object values, array elements, etc.).
 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
}

/**
 * Scan all string values inside a resource block and return the set of
 * resource IDs (type.name) that are referenced.
 */
function findReferences(block: Record<string, unknown>, knownIds: Set<string>): Set<string> {
  const strings: string[] = [];
  collectStrings(block, strings);

  const refs = new Set<string>();
  for (const s of strings) {
    // Reset lastIndex between iterations since the regex is global.
    REFERENCE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REFERENCE_PATTERN.exec(s)) !== null) {
      const candidateId = `${match[1]}.${match[2]}`;
      if (knownIds.has(candidateId)) {
        refs.add(candidateId);
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// depends_on extraction from raw HCL JSON
// ---------------------------------------------------------------------------

/**
 * Pull depends_on entries from an HCL JSON resource block. Terraform
 * serialises them as an array of strings such as
 * `["aws_subnet.main", "aws_security_group.web"]`.
 */
function extractDependsOn(block: unknown): string[] {
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];

  const rawBlock = block as Record<string, unknown>;
  const raw = rawBlock["depends_on"];
  if (!raw) return [];

  // HCL JSON may represent it as a flat array or a nested array.
  const items: string[] = [];

  function flatten(v: unknown): void {
    if (typeof v === "string") {
      items.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        flatten(item);
      }
    }
  }

  flatten(raw);
  return items;
}

// ---------------------------------------------------------------------------
// Build graph
// ---------------------------------------------------------------------------

/**
 * Build a dependency graph from a list of parsed resources and the raw HCL
 * JSON from which they were extracted.
 *
 * Two types of edges are detected:
 *   - "reference"  – an attribute value in one resource contains a reference
 *                    to another known resource (e.g. `aws_subnet.main.id`).
 *   - "depends_on" – the resource block contains an explicit `depends_on`
 *                    array listing another resource.
 *
 * Self-references and references to unknown resource IDs are silently ignored.
 * Duplicate edges (same from/to/relationship triple) are deduplicated.
 */
export function buildDependencyGraph(
  resources: ParsedResource[],
  hclJson: Record<string, unknown>,
): DependencyGraph {
  // Build a lookup of base IDs (type.name) — we strip count/for_each suffixes
  // so that `aws_instance.web[0]` maps back to `aws_instance.web`.
  const baseIdOf = (id: string): string => id.replace(/\[.*?\]$/, "");

  const knownBaseIds = new Set<string>(resources.map((r) => baseIdOf(r.id)));

  // Nodes – one per unique base ID to avoid duplicating count-expanded resources.
  const seenNodeIds = new Set<string>();
  const nodes: DependencyNode[] = [];
  for (const r of resources) {
    const base = baseIdOf(r.id);
    if (!seenNodeIds.has(base)) {
      seenNodeIds.add(base);
      nodes.push({ id: base, type: r.type, provider: r.provider });
    }
  }

  // Edges
  const edgeSet = new Set<string>();
  const edges: DependencyEdge[] = [];

  function addEdge(from: string, to: string, rel: DependencyEdge["relationship"]): void {
    if (from === to) return; // no self-edges
    const key = `${from}||${to}||${rel}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({ from, to, relationship: rel });
    }
  }

  // Walk HCL JSON resource blocks for reference and depends_on edges.
  const resourceBlock = hclJson["resource"];
  if (resourceBlock && typeof resourceBlock === "object" && !Array.isArray(resourceBlock)) {
    for (const [resourceType, instances] of Object.entries(
      resourceBlock as Record<string, unknown>,
    )) {
      if (!instances || typeof instances !== "object" || Array.isArray(instances)) {
        continue;
      }

      for (const [resourceName, blockList] of Object.entries(
        instances as Record<string, unknown>,
      )) {
        const fromId = `${resourceType}.${resourceName}`;
        if (!knownBaseIds.has(fromId)) continue;

        const block =
          Array.isArray(blockList) && blockList.length > 0
            ? (blockList[0] as Record<string, unknown>)
            : null;

        if (!block) continue;

        // Reference edges – scan attribute values
        const refs = findReferences(block, knownBaseIds);
        for (const toId of refs) {
          if (toId !== fromId) {
            addEdge(fromId, toId, "reference");
          }
        }

        // depends_on edges
        const deps = extractDependsOn(block);
        for (const dep of deps) {
          // Normalise "aws_subnet.main" or "aws_subnet.main.id" to base ID.
          const parts = dep.trim().split(".");
          if (parts.length >= 2) {
            const toId = `${parts[0]}.${parts[1]}`;
            if (knownBaseIds.has(toId) && toId !== fromId) {
              addEdge(fromId, toId, "depends_on");
            }
          }
        }
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Mermaid diagram generation
// ---------------------------------------------------------------------------

/**
 * Sanitise a resource ID for use as a Mermaid node identifier.
 * Dots, hyphens, and square brackets are replaced with underscores.
 */
function sanitiseNodeId(id: string): string {
  return id.replace(/[.\-[\]"]/g, "_");
}

/**
 * Generate a Mermaid flowchart diagram string from a DependencyGraph.
 *
 * Each resource becomes a node with its full ID as a label, and each edge
 * is annotated with its relationship type. Resources with no edges are still
 * rendered as isolated nodes.
 */
export function generateMermaidDiagram(graph: DependencyGraph): string {
  const lines: string[] = ["graph TD"];

  // Node declarations
  for (const node of graph.nodes) {
    const safeId = sanitiseNodeId(node.id);
    lines.push(`  ${safeId}["${node.id}"]`);
  }

  // Edge declarations
  for (const edge of graph.edges) {
    const from = sanitiseNodeId(edge.from);
    const to = sanitiseNodeId(edge.to);
    lines.push(`  ${from} -->|${edge.relationship}| ${to}`);
  }

  return lines.join("\n");
}

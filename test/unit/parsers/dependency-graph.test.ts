import { describe, it, expect } from "vitest";
import {
  buildDependencyGraph,
  generateMermaidDiagram,
} from "../../../src/parsers/dependency-graph.js";
import type { DependencyGraph } from "../../../src/parsers/dependency-graph.js";
import type { ParsedResource } from "../../../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResource(
  type: string,
  name: string,
  provider: "aws" | "azure" | "gcp" = "aws",
): ParsedResource {
  return {
    id: `${type}.${name}`,
    type,
    name,
    provider,
    region: "us-east-1",
    attributes: {},
    tags: {},
    source_file: "main.tf",
  };
}

function makeHcl(
  resources: Array<{
    type: string;
    name: string;
    block: Record<string, unknown>;
  }>,
): Record<string, unknown> {
  const resourceSection: Record<string, Record<string, unknown[]>> = {};
  for (const { type, name, block } of resources) {
    if (!resourceSection[type]) {
      resourceSection[type] = {};
    }
    resourceSection[type][name] = [block];
  }
  return { resource: resourceSection };
}

// ---------------------------------------------------------------------------
// buildDependencyGraph – nodes
// ---------------------------------------------------------------------------

describe("buildDependencyGraph – nodes", () => {
  it("creates one node per resource", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_subnet", "main")];
    const hcl = makeHcl([
      { type: "aws_instance", name: "web", block: {} },
      { type: "aws_subnet", name: "main", block: {} },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    expect(graph.nodes).toHaveLength(2);
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain("aws_instance.web");
    expect(ids).toContain("aws_subnet.main");
  });

  it("stores the correct type and provider on each node", () => {
    const resources = [makeResource("aws_instance", "web")];
    const hcl = makeHcl([{ type: "aws_instance", name: "web", block: {} }]);

    const graph = buildDependencyGraph(resources, hcl);
    const node = graph.nodes.find((n) => n.id === "aws_instance.web");
    expect(node?.type).toBe("aws_instance");
    expect(node?.provider).toBe("aws");
  });

  it("deduplicates nodes for count-expanded resources", () => {
    const resources: ParsedResource[] = [
      { ...makeResource("aws_instance", "web"), id: "aws_instance.web[0]" },
      { ...makeResource("aws_instance", "web"), id: "aws_instance.web[1]" },
    ];
    const hcl = makeHcl([{ type: "aws_instance", name: "web", block: {} }]);

    const graph = buildDependencyGraph(resources, hcl);
    expect(graph.nodes.filter((n) => n.id === "aws_instance.web")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildDependencyGraph – reference edges
// ---------------------------------------------------------------------------

describe("buildDependencyGraph – reference detection", () => {
  it("creates a reference edge when a string attribute matches another resource ID", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_subnet", "main")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: { subnet_id: "aws_subnet.main.id" },
      },
      { type: "aws_subnet", name: "main", block: {} },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    const edge = graph.edges.find(
      (e) =>
        e.from === "aws_instance.web" &&
        e.to === "aws_subnet.main" &&
        e.relationship === "reference",
    );
    expect(edge).toBeDefined();
  });

  it("finds references embedded inside template strings", () => {
    const resources = [
      makeResource("aws_instance", "web"),
      makeResource("aws_security_group", "sg"),
    ];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: { vpc_security_group_ids: ["${aws_security_group.sg.id}"] },
      },
      { type: "aws_security_group", name: "sg", block: {} },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    const edge = graph.edges.find(
      (e) =>
        e.from === "aws_instance.web" &&
        e.to === "aws_security_group.sg" &&
        e.relationship === "reference",
    );
    expect(edge).toBeDefined();
  });

  it("finds references nested inside objects", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_subnet", "main")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: {
          network_interface: [{ subnet_id: "aws_subnet.main.id" }],
        },
      },
      { type: "aws_subnet", name: "main", block: {} },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    const edge = graph.edges.find(
      (e) => e.from === "aws_instance.web" && e.to === "aws_subnet.main",
    );
    expect(edge).toBeDefined();
  });

  it("does not create an edge for references to unknown resources", () => {
    const resources = [makeResource("aws_instance", "web")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: { subnet_id: "aws_subnet.nonexistent.id" },
      },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    expect(graph.edges).toHaveLength(0);
  });

  it("does not create a self-referential edge", () => {
    const resources = [makeResource("aws_instance", "web")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        // Tags referencing itself should be ignored
        block: { tags: { self: "aws_instance.web" } },
      },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    const selfEdges = graph.edges.filter(
      (e) => e.from === "aws_instance.web" && e.to === "aws_instance.web",
    );
    expect(selfEdges).toHaveLength(0);
  });

  it("deduplicates edges when the same reference appears multiple times", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_subnet", "main")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: {
          subnet_id: "aws_subnet.main.id",
          // second reference to the same target
          secondary_subnet: "aws_subnet.main.cidr_block",
        },
      },
      { type: "aws_subnet", name: "main", block: {} },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    const dupes = graph.edges.filter(
      (e) =>
        e.from === "aws_instance.web" &&
        e.to === "aws_subnet.main" &&
        e.relationship === "reference",
    );
    expect(dupes).toHaveLength(1);
  });

  it("produces no edges when no resources have dependencies", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_s3_bucket", "data")];
    const hcl = makeHcl([
      { type: "aws_instance", name: "web", block: { ami: "ami-abc123" } },
      { type: "aws_s3_bucket", name: "data", block: { bucket: "my-bucket" } },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildDependencyGraph – depends_on edges
// ---------------------------------------------------------------------------

describe("buildDependencyGraph – depends_on edges", () => {
  it("creates a depends_on edge from an explicit depends_on array", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_subnet", "main")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: { depends_on: ["aws_subnet.main"] },
      },
      { type: "aws_subnet", name: "main", block: {} },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    const edge = graph.edges.find(
      (e) =>
        e.from === "aws_instance.web" &&
        e.to === "aws_subnet.main" &&
        e.relationship === "depends_on",
    );
    expect(edge).toBeDefined();
  });

  it("handles depends_on entries with attribute suffix (resource.name.attr)", () => {
    const resources = [
      makeResource("aws_instance", "web"),
      makeResource("aws_security_group", "sg"),
    ];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: { depends_on: ["aws_security_group.sg.id"] },
      },
      { type: "aws_security_group", name: "sg", block: {} },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    const edge = graph.edges.find(
      (e) =>
        e.from === "aws_instance.web" &&
        e.to === "aws_security_group.sg" &&
        e.relationship === "depends_on",
    );
    expect(edge).toBeDefined();
  });

  it("ignores depends_on entries that reference unknown resources", () => {
    const resources = [makeResource("aws_instance", "web")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: { depends_on: ["aws_vpc.nonexistent"] },
      },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    const depEdges = graph.edges.filter((e) => e.relationship === "depends_on");
    expect(depEdges).toHaveLength(0);
  });

  it("coexists with reference edges on the same resource without duplication", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_subnet", "main")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        // reference via attribute AND explicit depends_on
        block: {
          subnet_id: "aws_subnet.main.id",
          depends_on: ["aws_subnet.main"],
        },
      },
      { type: "aws_subnet", name: "main", block: {} },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    // Both edge types are distinct and should each appear once
    const refEdge = graph.edges.find(
      (e) =>
        e.from === "aws_instance.web" &&
        e.to === "aws_subnet.main" &&
        e.relationship === "reference",
    );
    const depEdge = graph.edges.find(
      (e) =>
        e.from === "aws_instance.web" &&
        e.to === "aws_subnet.main" &&
        e.relationship === "depends_on",
    );
    expect(refEdge).toBeDefined();
    expect(depEdge).toBeDefined();
    expect(graph.edges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// generateMermaidDiagram
// ---------------------------------------------------------------------------

describe("generateMermaidDiagram", () => {
  it("starts with 'graph TD'", () => {
    const graph: DependencyGraph = { nodes: [], edges: [] };
    const diagram = generateMermaidDiagram(graph);
    expect(diagram.startsWith("graph TD")).toBe(true);
  });

  it("includes node declarations for every resource", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_subnet", "main")];
    const hcl = makeHcl([
      { type: "aws_instance", name: "web", block: {} },
      { type: "aws_subnet", name: "main", block: {} },
    ]);
    const graph = buildDependencyGraph(resources, hcl);
    const diagram = generateMermaidDiagram(graph);

    expect(diagram).toContain('aws_instance_web["aws_instance.web"]');
    expect(diagram).toContain('aws_subnet_main["aws_subnet.main"]');
  });

  it("renders edge arrows between connected nodes", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_subnet", "main")];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: { subnet_id: "aws_subnet.main.id" },
      },
      { type: "aws_subnet", name: "main", block: {} },
    ]);
    const graph = buildDependencyGraph(resources, hcl);
    const diagram = generateMermaidDiagram(graph);

    expect(diagram).toContain("aws_instance_web -->|reference| aws_subnet_main");
  });

  it("renders depends_on edge label correctly", () => {
    const resources = [
      makeResource("aws_instance", "web"),
      makeResource("aws_security_group", "sg"),
    ];
    const hcl = makeHcl([
      {
        type: "aws_instance",
        name: "web",
        block: { depends_on: ["aws_security_group.sg"] },
      },
      { type: "aws_security_group", name: "sg", block: {} },
    ]);
    const graph = buildDependencyGraph(resources, hcl);
    const diagram = generateMermaidDiagram(graph);

    expect(diagram).toContain("aws_instance_web -->|depends_on| aws_security_group_sg");
  });

  it("sanitises dots in node IDs to underscores", () => {
    const resources = [makeResource("aws_instance", "web")];
    const hcl = makeHcl([{ type: "aws_instance", name: "web", block: {} }]);
    const graph = buildDependencyGraph(resources, hcl);
    const diagram = generateMermaidDiagram(graph);

    // The mermaid node identifier should not contain dots
    const lines = diagram.split("\n");
    const nodeLine = lines.find((l) => l.includes("aws_instance_web"));
    expect(nodeLine).toBeDefined();
    // Node identifier part (before the label) must not contain a dot
    const nodeId = nodeLine!.trim().split("[")[0];
    expect(nodeId).not.toContain(".");
  });

  it("produces a valid diagram for a graph with no edges", () => {
    const resources = [makeResource("aws_instance", "web"), makeResource("aws_s3_bucket", "data")];
    const hcl = makeHcl([
      { type: "aws_instance", name: "web", block: {} },
      { type: "aws_s3_bucket", name: "data", block: {} },
    ]);
    const graph = buildDependencyGraph(resources, hcl);
    const diagram = generateMermaidDiagram(graph);

    expect(diagram).toContain("graph TD");
    expect(diagram).toContain('aws_instance_web["aws_instance.web"]');
    expect(diagram).toContain('aws_s3_bucket_data["aws_s3_bucket.data"]');
    expect(diagram).not.toContain("-->");
  });

  it("returns just 'graph TD' for an empty graph", () => {
    const graph: DependencyGraph = { nodes: [], edges: [] };
    const diagram = generateMermaidDiagram(graph);
    expect(diagram.trim()).toBe("graph TD");
  });
});

// ---------------------------------------------------------------------------
// Full integration — multi-resource graph with mixed edge types
// ---------------------------------------------------------------------------

describe("buildDependencyGraph – multi-resource integration", () => {
  it("builds the correct graph for a VPC + subnet + instance topology", () => {
    const resources = [
      makeResource("aws_vpc", "main"),
      makeResource("aws_subnet", "public"),
      makeResource("aws_instance", "web"),
    ];
    const hcl = makeHcl([
      { type: "aws_vpc", name: "main", block: {} },
      {
        type: "aws_subnet",
        name: "public",
        block: { vpc_id: "aws_vpc.main.id" },
      },
      {
        type: "aws_instance",
        name: "web",
        block: {
          subnet_id: "aws_subnet.public.id",
          depends_on: ["aws_vpc.main"],
        },
      },
    ]);

    const graph = buildDependencyGraph(resources, hcl);
    expect(graph.nodes).toHaveLength(3);

    const subnetToVpc = graph.edges.find(
      (e) =>
        e.from === "aws_subnet.public" && e.to === "aws_vpc.main" && e.relationship === "reference",
    );
    const webToSubnet = graph.edges.find(
      (e) =>
        e.from === "aws_instance.web" &&
        e.to === "aws_subnet.public" &&
        e.relationship === "reference",
    );
    const webToVpc = graph.edges.find(
      (e) =>
        e.from === "aws_instance.web" && e.to === "aws_vpc.main" && e.relationship === "depends_on",
    );

    expect(subnetToVpc).toBeDefined();
    expect(webToSubnet).toBeDefined();
    expect(webToVpc).toBeDefined();
  });

  it("handles a resource with no attributes or depends_on without crashing", () => {
    const resources = [makeResource("aws_instance", "solo"), makeResource("aws_s3_bucket", "logs")];
    const hcl = makeHcl([
      { type: "aws_instance", name: "solo", block: {} },
      { type: "aws_s3_bucket", name: "logs", block: {} },
    ]);

    expect(() => buildDependencyGraph(resources, hcl)).not.toThrow();
    const graph = buildDependencyGraph(resources, hcl);
    expect(graph.edges).toHaveLength(0);
  });

  it("returns an empty graph when no resources are provided", () => {
    const graph = buildDependencyGraph([], {});
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});

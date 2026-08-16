import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The supported-Node floor is a promise to everyone who installs this package.
 * Raising it is a breaking change, not a dependency update, and three places
 * have to agree about it:
 *
 *   package.json  engines.node   what npm enforces at install time
 *   ci.yml        test matrix    what is actually proven to work
 *   README        node badge     what a reader is told
 *
 * They did not agree. Renovate's "chore(deps): update node.js to v24" (#21)
 * rewrote engines.node from ">=20.20.2" to ">=24.15.0", treating a consumer
 * support floor as a build toolchain pin. That shipped: @jadenrazo/cloudcost-mcp@1.2.1
 * on the public registry declares `node >=24.15.0`, so it refuses to install on
 * Node 20 and 22 LTS - while this repository's own CI matrix tests on exactly
 * Node 20 and 22. The package claimed not to support the versions it was proving
 * it worked on.
 *
 * Nothing caught it because nothing looked. These assertions are the check.
 */

const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
  engines?: { node?: string };
};
const ciYml = readFileSync(".github/workflows/ci.yml", "utf-8");
const readme = readFileSync("README.md", "utf-8");

function floorMajor(range: string): number {
  const m = /^>=\s*(\d+)/.exec(range.trim());
  if (m === null) throw new Error(`engines.node must be a plain ">=X.Y.Z" floor, got ${range}`);
  return Number(m[1]);
}

describe("supported Node versions agree across package.json, CI and README", () => {
  const declared = pkg.engines?.node;

  it("declares a parseable floor", () => {
    expect(declared).toBeTypeOf("string");
    expect(() => floorMajor(declared as string)).not.toThrow();
  });

  it("does not claim to require a Node newer than CI proves", () => {
    // e.g. "node-version: [20, 22]"
    const matrix = /node-version:\s*\[([^\]]+)\]/.exec(ciYml);
    expect(matrix, "could not find the node-version matrix in ci.yml").not.toBeNull();

    const tested = (matrix as RegExpExecArray)[1]
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));

    expect(tested.length).toBeGreaterThan(0);

    const oldestTested = Math.min(...tested);
    const floor = floorMajor(declared as string);

    // The floor may be lower than the oldest tested version - claiming less than
    // you prove is merely conservative. It must never be higher: that tells
    // users a version does not work while CI demonstrates that it does.
    expect(
      floor,
      `engines.node is ">=${floor}" but CI tests on Node ${tested.join(", ")}. ` +
        `Raising the floor above the oldest tested version drops support for users ` +
        `on versions this repo actively proves work. If the drop is intentional, ` +
        `remove those versions from the ci.yml matrix in the same commit and cut a major.`,
    ).toBeLessThanOrEqual(oldestTested);
  });

  it("advertises the same floor in the README badge", () => {
    // https://img.shields.io/badge/node-%3E%3D20-brightgreen
    const badge = /badge\/node-%3E%3D(\d+)-/.exec(readme);
    expect(badge, "could not find the node version badge in README.md").not.toBeNull();

    const advertised = Number((badge as RegExpExecArray)[1]);
    expect(
      advertised,
      "the README badge and engines.node disagree about the minimum supported Node",
    ).toBe(floorMajor(declared as string));
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const action = parse(readFileSync(".github/actions/cost-estimate/action.yml", "utf8"));
const publish = parse(readFileSync(".github/workflows/publish.yml", "utf8"));

describe("release delivery contract", () => {
  it("keeps the lockfile and published package versions aligned", () => {
    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("keeps the cost-estimate Action on the release being shipped", () => {
    const install = action.runs.steps.find(
      (step: { name: string }) => step.name === "Install cloudcost-mcp",
    );
    expect(install.run).toBe(`npm install -g ${pkg.name}@${pkg.version}`);
  });

  it("blocks publishing on production advisories and stale pricing", () => {
    const steps = publish.jobs.publish.steps;
    const publishIndex = steps.findIndex((step: { run?: string }) =>
      step.run?.startsWith("npm publish"),
    );
    expect(publishIndex).toBeGreaterThan(0);
    for (const command of [
      "npm audit --audit-level=high --omit=dev",
      "npx tsx scripts/check-freshness.ts",
    ]) {
      const gateIndex = steps.findIndex((step: { run?: string }) => step.run === command);
      expect(gateIndex).toBeGreaterThanOrEqual(0);
      expect(gateIndex).toBeLessThan(publishIndex);
      expect(steps[gateIndex]["continue-on-error"]).not.toBe(true);
    }
  });

  it("publishes through the release event with provenance and a release SBOM", () => {
    expect(publish.on.release.types).toEqual(["published"]);
    const steps = publish.jobs.publish.steps;
    expect(
      steps.some((step: { run?: string }) =>
        step.run?.includes("npm publish --access public --provenance"),
      ),
    ).toBe(true);
    expect(
      steps.some((step: { run?: string }) =>
        step.run?.includes("npm sbom --sbom-format cyclonedx"),
      ),
    ).toBe(true);
    expect(publish.jobs.publish.permissions["id-token"]).toBe("write");
  });
});

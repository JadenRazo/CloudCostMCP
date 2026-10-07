import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { recoveryDecision, recover } from "../../../scripts/refresh-recovery.mjs";

const writes = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeFileSync: writes,
}));

const run = {
  name: "Refresh Pricing",
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
  event: "schedule",
  head_branch: "main",
  head_sha: "abc",
  head_repository: { full_name: "JadenRazo/CloudCostMCP" },
};
const jobs = [
  { name: "refresh", runner_id: 0, steps: [], conclusion: "cancelled" },
  { name: "Dispatch CI for fallback PR", conclusion: "skipped" },
];
const annotations = [
  { message: "The job was not acquired by Runner of type hosted even after multiple attempts" },
];
const scope = { repository: "JadenRazo/CloudCostMCP", defaultBranch: "main" };

describe("refresh recovery policy", () => {
  it("recovers the observed October 5 failure even when no logs exist", () => {
    expect(recoveryDecision(run, jobs, annotations, scope).retry).toBe(true);
  });
  it.each([2, 3])("never retries attempt %i again", (run_attempt) => {
    expect(recoveryDecision({ ...run, run_attempt }, jobs, annotations, scope).retry).toBe(false);
  });
  it("does not retry without the authoritative acquisition annotation", () => {
    expect(recoveryDecision(run, jobs, [], scope).retry).toBe(false);
  });
  it("cannot replay an older scheduled revision from a manual feature-branch recovery", () => {
    expect(recoveryDecision(run, jobs, annotations, { ...scope, manualSha: "other" }).retry).toBe(
      false,
    );
  });
  it("does not replay provider failures or partial writes", () => {
    expect(
      recoveryDecision(
        run,
        [
          {
            ...jobs[0],
            runner_id: 123,
            steps: [{ name: "Run pricing refresh", conclusion: "failure" }],
          },
        ],
        annotations,
        scope,
      ).retry,
    ).toBe(false);
  });
  it("does not rerun a successful handoff", () => {
    expect(
      recoveryDecision(run, [jobs[0], { ...jobs[1], conclusion: "success" }], annotations, scope)
        .retry,
    ).toBe(false);
  });
  it.each(["pull_request", "workflow_dispatch", "push"])(
    "rejects untrusted %s triggers",
    (event) => {
      expect(recoveryDecision({ ...run, event }, jobs, annotations, scope).retry).toBe(false);
    },
  );
  it("rejects forks, wrong workflows, non-default schedules and in-flight runs", () => {
    for (const change of [
      { head_repository: { full_name: "someone/CloudCostMCP" } },
      { name: "CI" },
      { head_branch: "unreviewed" },
      { status: "in_progress" },
      { conclusion: "success" },
    ])
      expect(recoveryDecision({ ...run, ...change }, jobs, annotations, scope).retry).toBe(false);
  });
  it("allows only an exact-commit manual preview probe before any side effects", () => {
    const preview = { ...run, event: "workflow_dispatch" };
    const probeJobs = [
      {
        ...jobs[0],
        runner_id: 123,
        steps: [
          { name: "Exercise recovery boundary", conclusion: "failure" },
          { name: "Checkout", conclusion: "skipped" },
        ],
      },
      jobs[1],
    ];
    const probeAnnotation = [{ title: "Refresh recovery probe", message: "preview" }];
    expect(
      recoveryDecision(preview, probeJobs, probeAnnotation, { ...scope, manualSha: "abc" }).retry,
    ).toBe(true);
    expect(
      recoveryDecision(preview, probeJobs, probeAnnotation, { ...scope, manualSha: "other" }).retry,
    ).toBe(false);
    probeJobs[0].steps.push({ name: "Open pricing refresh PR", conclusion: "success" });
    expect(
      recoveryDecision(preview, probeJobs, probeAnnotation, { ...scope, manualSha: "abc" }).retry,
    ).toBe(false);
  });
});

describe("workflow recovery and preview contract", () => {
  it("keeps dispatch permission isolated and preview PR/issue writes disabled", () => {
    const workflow = parse(readFileSync(".github/workflows/refresh-pricing.yml", "utf8"));
    const refresh = workflow.jobs.refresh;
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.on.workflow_dispatch.inputs.preview.default).toBe(true);
    expect(refresh["runs-on"]).toBe("ubuntu-24.04");
    for (const name of [
      "Mint app token",
      "Open pricing refresh PR",
      "File issue on refresh failure",
    ]) {
      const step = refresh.steps.find((s: { name: string }) => s.name === name);
      expect(step.if).toContain("!inputs.preview");
    }
    expect(workflow.jobs["dispatch-fallback-ci"].permissions).toEqual({ actions: "write" });
    expect(workflow.permissions.actions).toBeUndefined();
    expect(workflow.jobs["dispatch-fallback-ci"].if).toContain("always()");
  });
  it("runs recovery with trusted code, no PR credentials and a single run scope", () => {
    const workflow = parse(readFileSync(".github/workflows/refresh-pricing-recovery.yml", "utf8"));
    expect(workflow.on.workflow_run.workflows).toEqual(["Refresh Pricing"]);
    expect(workflow.concurrency.group).toContain("workflow_run.id");
    expect(workflow.jobs.recover.permissions).toEqual({
      contents: "read",
      checks: "read",
      actions: "write",
    });
    expect(workflow.jobs.recover.steps[0].with.ref).toBeUndefined();
    expect(workflow.jobs.recover.steps[0].with["persist-credentials"]).toBe(false);
  });
});

describe("recovery API handoff", () => {
  function apiFor(currentRun = run) {
    return vi.fn((path: string, method = "GET") => {
      if (method === "POST") return null;
      if (path.includes("/annotations")) return annotations;
      if (path.includes("/jobs?")) return { jobs: jobs.map((job) => ({ ...job, id: 42 })) };
      return {
        ...currentRun,
        id: 123,
        html_url: "https://github.com/JadenRazo/CloudCostMCP/actions/runs/123",
      };
    });
  }
  it("records diagnostics before requesting exactly one failed-job rerun", () => {
    const api = apiFor();
    const receipt = recover({ ...scope, runId: "123", apply: true, api });
    expect(receipt.applied).toBe(true);
    expect(api.mock.calls.filter(([, method]) => method === "POST")).toEqual([
      ["repos/JadenRazo/CloudCostMCP/actions/jobs/42/rerun", "POST"],
    ]);
    const first = writes.mock.calls.at(-2)!;
    expect(JSON.parse(first[1]).applied).toBe(false);
  });
  it("dry runs without mutating Actions", () => {
    const api = apiFor();
    expect(recover({ ...scope, runId: "123", apply: false, api }).applied).toBe(false);
    expect(api.mock.calls.every(([, method]) => method !== "POST")).toBe(true);
  });
  it("leaves provider failures and attempts after the retry untouched", () => {
    const api = apiFor({ ...run, run_attempt: 2 });
    expect(recover({ ...scope, runId: "123", apply: true, api }).applied).toBe(false);
    expect(api.mock.calls.every(([, method]) => method !== "POST")).toBe(true);
  });
});

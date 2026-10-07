import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  fetchLatestRefreshRun,
  selectLatestRefreshRun,
} from "../../../scripts/latest-refresh-run.mjs";

const scope = { branch: "main", workflowId: 261469346, now: Date.parse("2026-10-07T08:00:00Z") };
const old = {
  id: 29258028417,
  workflow_id: scope.workflowId,
  head_branch: "main",
  created_at: "2026-07-13T14:27:33Z",
  conclusion: "failure",
  head_sha: "old",
  status: "completed",
};
const current = {
  ...old,
  id: 37587843867,
  created_at: "2026-10-07T07:31:24Z",
  conclusion: "success",
  head_sha: "692aac5",
};

describe("refresh liveness run selection", () => {
  it("selects the October 7 success rather than the observed July 13 failure even if history is unordered", () => {
    expect(selectLatestRefreshRun([old, current], scope)[0].databaseId).toBe(current.id);
    expect(selectLatestRefreshRun([current, old], scope)[0].databaseId).toBe(current.id);
  });

  it("keeps the newest failure visible rather than choosing the last success", () => {
    const failed = {
      ...current,
      id: current.id + 1,
      created_at: "2026-10-07T07:40:00Z",
      conclusion: "failure",
    };
    expect(selectLatestRefreshRun([failed, current], scope)[0].conclusion).toBe("failure");
  });

  it("does not let a recently rerun old success mask the newest failed firing", () => {
    const failed = { ...current, conclusion: "failure" };
    expect(
      selectLatestRefreshRun(
        [{ ...old, conclusion: "success", updated_at: "2026-10-07T07:59:00Z" }, failed],
        scope,
      )[0].databaseId,
    ).toBe(current.id);
  });

  it("ignores another branch and another workflow regardless of date", () => {
    const newer = { ...current, created_at: "2026-10-07T07:59:00Z" };
    expect(
      selectLatestRefreshRun(
        [old, { ...newer, head_branch: "preview" }, { ...newer, workflow_id: 123 }],
        scope,
      )[0].databaseId,
    ).toBe(old.id);
  });

  it("preserves queued/in-progress status and null conclusion for the existing gate", () => {
    expect(
      selectLatestRefreshRun([{ ...current, status: "queued", conclusion: null }], scope)[0],
    ).toMatchObject({ status: "queued", conclusion: null });
  });

  it("reports an empty scope rather than accepting another branch's success", () => {
    expect(selectLatestRefreshRun([{ ...current, head_branch: "preview" }], scope)).toEqual([]);
  });

  it.each(["invalid", "2026-10-07T08:10:00Z"])(
    "rejects an ambiguous timestamp %s rather than certifying the loop",
    (created_at) => {
      expect(() => selectLatestRefreshRun([{ ...current, created_at }], scope)).toThrow();
    },
  );

  it("queries the current workflow ID, explicit branch and all REST pages before selecting", () => {
    const api = vi
      .fn()
      .mockReturnValueOnce({
        id: scope.workflowId,
        path: ".github/workflows/refresh-pricing.yml",
        state: "active",
      })
      .mockReturnValueOnce([{ workflow_runs: [old] }, { workflow_runs: [current] }]);
    const receipt = fetchLatestRefreshRun({
      repository: "JadenRazo/CloudCostMCP",
      branch: "fix/a b",
      api,
      now: scope.now,
    });
    expect(api.mock.calls[1]).toEqual([
      "repos/JadenRazo/CloudCostMCP/actions/workflows/261469346/runs?branch=fix%2Fa%20b&per_page=100",
      true,
    ]);
    expect(receipt.observedRuns).toBe(2);
    expect(receipt.selected).toEqual([]);
    const mainApi = vi
      .fn()
      .mockReturnValueOnce({
        id: scope.workflowId,
        path: ".github/workflows/refresh-pricing.yml",
        state: "active",
      })
      .mockReturnValueOnce([{ workflow_runs: [old] }, { workflow_runs: [current] }]);
    expect(
      fetchLatestRefreshRun({
        repository: "JadenRazo/CloudCostMCP",
        branch: "main",
        api: mainApi,
        now: scope.now,
      }).selected[0].databaseId,
    ).toBe(current.id);
  });

  it("fails closed on an unavailable or disabled workflow instead of changing the threshold", () => {
    expect(() =>
      fetchLatestRefreshRun({
        repository: "JadenRazo/CloudCostMCP",
        branch: "main",
        api: () => {
          throw new Error("403");
        },
      }),
    ).toThrow("403");
    expect(() =>
      fetchLatestRefreshRun({
        repository: "JadenRazo/CloudCostMCP",
        branch: "main",
        api: () => ({ path: ".github/workflows/refresh-pricing.yml", state: "disabled_manually" }),
      }),
    ).toThrow("disabled");
  });

  it("keeps the health gate on validated REST selection with unknown failures reported", () => {
    const health = parse(readFileSync(".github/workflows/health.yml", "utf8"));
    const loop = health.jobs.health.steps.find((step: { id?: string }) => step.id === "loop");
    expect(loop.run).toContain("node scripts/latest-refresh-run.mjs");
    expect(loop.run).toContain('echo "code=2"');
    expect(loop.run).toContain('[ "$age" -gt 10 ]');
    expect(loop.run).toContain("last refresh concluded");
    expect(health.jobs.health.permissions.actions).toBe("read");
  });
});

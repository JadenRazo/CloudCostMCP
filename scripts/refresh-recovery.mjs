import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Provider failures are not acquisition failures. Retry only when GitHub
// proves that a hosted runner never executed the job.
export function recoveryDecision(run, jobs, annotations, { repository, defaultBranch, manualSha }) {
  if (run.name !== "Refresh Pricing" || run.head_repository?.full_name !== repository) {
    return { retry: false, reason: "not this repository's pricing workflow" };
  }
  if (run.status !== "completed" || !["failure", "cancelled"].includes(run.conclusion)) {
    return { retry: false, reason: "run is successful or still in progress" };
  }
  if (run.run_attempt !== 1) return { retry: false, reason: "one retry already used" };
  if (manualSha && manualSha !== run.head_sha) {
    return { retry: false, reason: "manual recovery must match the refresh revision" };
  }
  const scheduled = run.event === "schedule" && run.head_branch === defaultBranch;
  const manual = run.event === "workflow_dispatch" && manualSha === run.head_sha;
  if (!scheduled && !manual) return { retry: false, reason: "untrusted event, branch or revision" };
  const refresh = jobs.find((job) => job.name === "refresh");
  const dispatch = jobs.find((job) => job.name === "Dispatch CI for fallback PR");
  if (!refresh || dispatch?.conclusion === "success") {
    return { retry: false, reason: "refresh missing or handoff already completed" };
  }
  const unallocated = refresh.runner_id === 0 && refresh.steps.length === 0;
  const acquisitionFailure = annotations.some((a) =>
    a.message.includes("The job was not acquired by Runner of type hosted"),
  );
  if (unallocated && acquisitionFailure) {
    return { retry: true, reason: "GitHub could not acquire a hosted runner; no steps executed" };
  }
  // The exact-commit preview probe fails before checkout, token minting or
  // pricing writes. It exercises the real rerun and downstream handoff.
  const probe =
    manual &&
    annotations.some((a) => a.title === "Refresh recovery probe") &&
    refresh.steps.some(
      (s) => s.name === "Exercise recovery boundary" && s.conclusion === "failure",
    ) &&
    refresh.steps
      .filter(
        (s) =>
          ![
            "Set up job",
            "Exercise recovery boundary",
            "Retain refresh evidence",
            "Fail job if refresh failed",
            "Complete job",
          ].includes(s.name),
      )
      .every((s) => s.conclusion === "skipped");
  return {
    retry: probe,
    reason: probe ? "manual preview recovery probe" : "no proven runner acquisition failure",
  };
}

export function recover({ runId, repository, defaultBranch, manualSha, apply, api }) {
  if (!/^[1-9][0-9]*$/.test(String(runId))) throw new Error("run-id must be a positive integer");
  const base = `repos/${repository}`;
  const run = api(`${base}/actions/runs/${runId}`);
  const jobs = api(
    `${base}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
  ).jobs;
  const refresh = jobs.find((job) => job.name === "refresh");
  const annotations = refresh
    ? api(`${base}/check-runs/${refresh.id}/annotations?per_page=100`)
    : [];
  const decision = recoveryDecision(run, jobs, annotations, {
    repository,
    defaultBranch,
    manualSha,
  });
  const receipt = {
    run: { id: run.id, attempt: run.run_attempt, sha: run.head_sha, url: run.html_url },
    jobs,
    annotations,
    decision,
    applied: false,
  };
  // Retain evidence before the sole mutation, including when that POST fails.
  writeFileSync("refresh-recovery.json", JSON.stringify(receipt, null, 2) + "\n");
  if (decision.retry && apply) {
    // This endpoint explicitly includes dependent jobs, so the skipped CI
    // handoff is rerun even when acquisition concluded "cancelled".
    api(`${base}/actions/jobs/${refresh.id}/rerun`, "POST");
    receipt.applied = true;
    writeFileSync("refresh-recovery.json", JSON.stringify(receipt, null, 2) + "\n");
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = recover({
    runId: process.env.RUN_ID,
    repository: process.env.GITHUB_REPOSITORY,
    defaultBranch: process.env.DEFAULT_BRANCH,
    manualSha: process.env.MANUAL_SHA,
    apply: process.env.APPLY === "true",
    api: (path, method = "GET") => {
      const output = execFileSync("gh", ["api", "--method", method, path], { encoding: "utf8" });
      return output.trim() ? JSON.parse(output) : null;
    },
  });
  const message = `${receipt.decision.reason}; retry submitted: ${receipt.applied}; ${receipt.run.url}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + "\n");
}

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workflowPath = ".github/workflows/refresh-pricing.yml";

export function selectLatestRefreshRun(runs, { branch, workflowId, now = Date.now() }) {
  if (!Array.isArray(runs) || !branch || !Number.isSafeInteger(workflowId)) {
    throw new Error("invalid refresh run scope or response");
  }
  const scoped = runs.filter((run) => run.head_branch === branch && run.workflow_id === workflowId);
  for (const run of scoped) {
    if (!Number.isFinite(Date.parse(run.created_at))) {
      throw new Error(`invalid creation timestamp for refresh run ${run.id}`);
    }
  }
  // Creation time describes the latest firing. updated_at can move an old
  // rerun ahead of a more recent failure and falsely certify the loop.
  scoped.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const latest = scoped[0];
  if (!latest) return [];
  if (Date.parse(latest.created_at) > now + 5 * 60 * 1000) {
    throw new Error(`future creation timestamp for refresh run ${latest.id}`);
  }
  return [
    {
      databaseId: latest.id,
      createdAt: latest.created_at,
      conclusion: latest.conclusion,
      headSha: latest.head_sha,
      status: latest.status,
      workflowId: latest.workflow_id,
    },
  ];
}

export function fetchLatestRefreshRun({ repository, branch, api, now }) {
  if (!repository || !branch) throw new Error("repository and branch are required");
  const base = `repos/${repository}/actions/workflows`;
  const workflow = api(`${base}/refresh-pricing.yml`);
  if (workflow.path !== workflowPath || workflow.state !== "active") {
    throw new Error("the current pricing refresh workflow is missing or disabled");
  }
  const pages = api(
    `${base}/${workflow.id}/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
    true,
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page.workflow_runs))) {
    throw new Error("invalid paginated refresh run response");
  }
  const runs = pages.flatMap((page) => page.workflow_runs);
  const selected = selectLatestRefreshRun(runs, { branch, workflowId: workflow.id, now });
  return { repository, branch, workflow, observedRuns: runs.length, selected };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = fetchLatestRefreshRun({
    repository: process.env.GITHUB_REPOSITORY,
    branch: process.env.GITHUB_REF_NAME,
    api: (path, paginate = false) =>
      JSON.parse(
        execFileSync(
          "gh",
          ["api", "--method", "GET", ...(paginate ? ["--paginate", "--slurp"] : []), path],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        ),
      ),
  });
  writeFileSync("refresh-liveness.json", JSON.stringify(receipt, null, 2) + "\n");
  console.error(
    `Refresh workflow ${receipt.workflow.id} (${receipt.workflow.path}), branch ${receipt.branch}; ${receipt.observedRuns} runs inspected by creation time.`,
  );
  console.log(JSON.stringify(receipt.selected));
}

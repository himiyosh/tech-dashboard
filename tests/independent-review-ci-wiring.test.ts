import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function readRepoFile(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function extractNamedStep(workflow: string, name: string) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`missing workflow step: ${name}`);
  }
  const remainder = workflow.slice(start + marker.length);
  const nextStep = remainder.search(/\n {6}- name:/);
  return workflow.slice(
    start,
    nextStep === -1 ? workflow.length : start + marker.length + nextStep,
  );
}

function extractJob(workflow: string, name: string) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`missing workflow job: ${name}`);
  }
  const bodyStart = start + marker.length;
  const remainder = workflow.slice(bodyStart);
  const nextJob = remainder.search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return workflow.slice(
    start,
    nextJob === -1 ? workflow.length : bodyStart + nextJob,
  );
}

describe("independent review CI wiring", () => {
  it("executes the strict gate for the current open pull request", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const workflow = readRepoFile(".github/workflows/ci.yml");
    const command = packageJson.scripts?.["check:independent-review"];

    expect(command).toBe("node scripts/check-independent-review.mjs");
    expect(command).not.toMatch(/\bnode\s+--check\b/);
    expect(workflow).toMatch(
      /^ {2}pull_request:\s*\n {4}branches:\s*\[main\]$/m,
    );

    const step = extractNamedStep(
      workflow,
      "Enforce exact-head independent review",
    );
    expect(step).toContain(
      "if: github.event_name == 'pull_request' && github.event.pull_request.state == 'open'",
    );
    expect(step).toContain("GH_TOKEN: ${{ github.token }}");
    expect(step).toContain(
      "PR_NUMBER: ${{ github.event.pull_request.number }}",
    );
    expect(step).toContain(
      "PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    expect(step).toContain(
      "MERGER_SESSION_ID: ${{ vars.INDEPENDENT_REVIEW_MERGER_SESSION_ID }}",
    );
    expect(step).toContain(
      "REVIEWER_SESSION_ID: ${{ vars.INDEPENDENT_REVIEW_REVIEWER_SESSION_ID }}",
    );
    expect(step).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq \'.state\'',
    );
    expect(step).toMatch(
      /case "\$CURRENT_PR_STATE" in[\s\S]*closed\)[\s\S]*exit 0[\s\S]*open\)[\s\S]*\*\)[\s\S]*exit 1/,
    );
    expect(step).toContain("npm run check:independent-review --");
    expect(step).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(step).toContain('--pr "$PR_NUMBER"');
    expect(step).toContain('--head "$PR_HEAD_SHA"');
    expect(step).toContain('--merger-session "$MERGER_SESSION_ID"');
    expect(step).toContain('--reviewer-session "$REVIEWER_SESSION_ID"');
    expect(step).not.toMatch(/\bnode\s+--check\b/);
  });

  it("runs review clearance independently from unit, build, and E2E quality jobs", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");
    const reviewJob = extractJob(workflow, "independent-review");
    const unitJob = extractJob(workflow, "unit");
    const webBuildJob = extractJob(workflow, "web-build");
    const e2eJob = extractJob(workflow, "e2e");

    expect(reviewJob).toContain("name: exact-head independent review");
    expect(reviewJob).toContain("name: Enforce exact-head independent review");
    expect(reviewJob).not.toMatch(/^ {4}needs:/m);
    expect(unitJob).not.toContain("Enforce exact-head independent review");
    expect(unitJob).not.toMatch(/^ {4}needs:/m);
    expect(webBuildJob).not.toMatch(/^ {4}needs:/m);
    expect(e2eJob).toContain("needs: [unit, web-build]");
    expect(e2eJob).not.toMatch(/needs:\s*\[[^\]]*independent-review/);
  });
});

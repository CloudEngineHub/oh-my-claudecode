/**
 * lookout feature tests: rule engine over briefing text and workspace
 * state on real temporary git repositories.
 *
 * The false-positive expectations are as important as the detection ones:
 * lookout died once before as `risk-assess` (#3164) because routine work
 * tripped the gate. Rules must fire on the dangerous operation itself and
 * stay silent on adjacent but harmless wording.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { LookoutError, resolveBriefArg, scanLookout } from "../index.js";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Create a real git repo with one commit and a clean tree. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omc-lookout-"));
  tempDirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"]);
  writeFileSync(join(dir, "base.txt"), "v1\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add base"]);
  return dir;
}

function ids(findings: { id: string }[]): string[] {
  return findings.map((f) => f.id);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("scanLookout: briefing rules", () => {
  const NOW = new Date("2026-09-08T00:00:00Z");
  // Fresh repo per test: afterEach wipes tempDirs, so a shared fixture
  // would leave later tests scanning a deleted directory.
  const base = () => ({ repo: makeRepo(), now: NOW });

  it("flags force operations as high severity with evidence", () => {
    const report = scanLookout({
      ...base(),
      brief: "Push the release: git push --force origin main if needed",
    });
    expect(ids(report.findings)).toContain("lookout.brief.force-op");
    const finding = report.findings.find((f) => f.id === "lookout.brief.force-op");
    expect(finding?.severity).toBe("high");
    expect(finding?.evidence).toContain("git push --force");
    expect(report.summary.verdict).toBe("review-recommended");
  });

  it("flags force flags in any position of the push command", () => {
    for (const brief of [
      "git push origin main --force",
      "git push -u origin main --force-with-lease",
      "git push --force origin main",
      "git push -f origin main",
      "git push origin main -f",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.force-op");
    }
  });

  it("flags raw git push commands targeting protected branches", () => {
    for (const brief of [
      "git push origin main",
      "git push -u upstream release",
      "git push origin HEAD:main",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.protected-branch");
    }
  });

  it("does not flag pushes to ordinary branches", () => {
    const report = scanLookout({ ...base(), brief: "git push origin feature/billing-v2" });
    expect(ids(report.findings)).not.toContain("lookout.brief.protected-branch");
  });

  it("flags destructive database operations", () => {
    const report = scanLookout({ ...base(), brief: "Run the cleanup: DROP TABLE old_events; then TRUNCATE TABLE session_log;" });
    expect(ids(report.findings)).toContain("lookout.brief.db-destructive");
    expect(report.summary.verdict).toBe("review-recommended");
  });

  it("flags equivalent destructive flag layouts", () => {
    for (const brief of [
      "rm -fr dir",
      "rm -r -f dir",
      "rm --recursive --force dir",
      "git clean -df",
      "git clean -f -d",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.force-op");
    }
  });

  it("flags leading-plus refspec force pushes", () => {
    for (const brief of [
      "git push origin +main",
      "git push origin +refs/heads/main",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.force-op");
    }
  });

  it("flags test deletion and test skipping", () => {
    const report = scanLookout({
      ...base(),
      brief: "To unblock the build, skip tests and remove test files that fail",
    });
    expect(ids(report.findings)).toContain("lookout.brief.test-deletion");
  });

  it("flags direct pushes to protected branches", () => {
    const report = scanLookout({
      ...base(),
      brief: "No PR needed this time, push into main directly",
    });
    expect(ids(report.findings)).toContain("lookout.brief.protected-branch");
  });

  it("flags secret and deploy surfaces as medium, not high", () => {
    const report = scanLookout({
      ...base(),
      brief: "Update the .env values and refresh the deploy config for staging",
    });
    const findings = report.findings.map((f) => [f.id, f.severity]);
    expect(findings).toContainEqual(["lookout.brief.secrets-touch", "medium"]);
    expect(findings).toContainEqual(["lookout.brief.deploy-touch", "medium"]);
    expect(report.summary.verdict).toBe("advisory");
  });

  it("flags CI configuration changes as medium", () => {
    const report = scanLookout({ ...base(), brief: "Tighten the CI pipeline timeouts" });
    expect(ids(report.findings)).toContain("lookout.brief.ci-touch");
  });

  it("flags raw pushes through custom remote names", () => {
    for (const brief of [
      "git push github main",
      "git push myremote release",
      "git push origin release/v2",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.protected-branch");
    }
  });

  it("stays silent on rebasing onto a protected branch and lookalike branches", () => {
    for (const brief of [
      "Rebase this feature branch onto main",
      "truncate only the display label",
      "git push origin release-candidate-notes",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).not.toContain("lookout.brief.protected-branch");
      expect(ids(report.findings)).not.toContain("lookout.brief.db-destructive");
    }
  });

  it("flags suite-type modifiers in skip instructions", () => {
    for (const brief of [
      "skip the unit tests to unblock the build",
      "disable integration tests for this run",
      "ignore flaky unit tests and continue",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.test-deletion");
    }
  });

  it("does not flag environment template mentions as secrets", () => {
    const report = scanLookout({ ...base(), brief: "Update .env.example placeholders and .env.template docs" });
    expect(ids(report.findings)).not.toContain("lookout.brief.secrets-touch");
  });

  it("stays silent on routine wording (anti false-positive contract)", () => {
    const report = scanLookout({
      ...base(),
      brief:
        "Add password validation to the signup form, document the auth flow, " +
        "write tests for the migration guide page, truncate the log file " +
        "before capturing fixtures, and clean up the docs folder.",
    });
    // "password validation", "auth flow", "migration guide", "test data"
    // are ordinary development topics — none is a danger signal.
    expect(report.findings).toEqual([]);
    expect(report.summary.verdict).toBe("clear");
  });

  it("reports every finding with evidence, high confidence, and advice", () => {
    const report = scanLookout({ ...base(), brief: "git reset --hard HEAD~3" });
    for (const finding of report.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.confidence).toBe("high");
      expect(finding.advice).toMatch(/approval-mode remote|checkpoint/);
    }
  });

  it("scans workspace only when no brief is given", () => {
    const report = scanLookout({ ...base() });
    expect(report.briefSource).toBe("none");
    expect(ids(report.findings)).not.toContain("lookout.brief.force-op");
  });
});

describe("scanLookout: workspace rules", () => {
  it("flags a dirty worktree as low severity with checkpoint advice", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "base.txt"), "v2\n");
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    const finding = report.findings.find((f) => f.id === "lookout.ws.dirty-worktree");
    expect(finding?.severity).toBe("low");
    expect(finding?.advice).toContain("omc checkpoint create");
    expect(report.summary.verdict).toBe("advisory"); // low findings are not "clear"
  });

  it("flags tracked secret-looking files", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    git(dir, ["add", ".env"]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    const finding = report.findings.find((f) => f.id === "lookout.ws.secrets-present");
    expect(finding?.severity).toBe("medium");
    expect(finding?.evidence).toContain(".env");
  });

  it("does not flag environment templates as secrets", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, ".env.example"), "API_KEY=placeholder\n");
    git(dir, ["add", ".env.example"]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env template"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).not.toContain("lookout.ws.secrets-present");
  });

  it("fails closed with exit code 2 for a nonexistent repository path", () => {
    try {
      scanLookout({ repo: "/nonexistent/omc-lookout-path", now: new Date("2026-09-08T00:00:00Z") });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LookoutError);
      expect((error as LookoutError).exitCode).toBe(2);
    }
  });

  it("reports a null repo outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-lookout-nogit-"));
    tempDirs.push(dir);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(report.repo).toBeNull();
    expect(report.findings).toEqual([]);
  });
});

describe("resolveBriefArg", () => {
  it("passes inline text through", () => {
    expect(resolveBriefArg("hello")).toEqual({ text: "hello", source: "flag" });
  });

  it("reads @file briefings", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-lookout-brief-"));
    tempDirs.push(dir);
    const path = join(dir, "brief.txt");
    writeFileSync(path, "git push --force origin main");
    const resolved = resolveBriefArg(`@${path}`);
    expect(resolved.source).toBe("file");
    expect(resolved.text).toContain("push --force");
  });

  it("fails closed with exit code 2 for unreadable files", () => {
    try {
      resolveBriefArg("@/nonexistent/omc-lookout-brief-missing.txt");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LookoutError);
      expect((error as LookoutError).exitCode).toBe(2);
    }
  });
});

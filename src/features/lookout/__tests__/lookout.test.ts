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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
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
    // evidence is the exact matched operand
    expect(finding?.evidence).toContain("--force");
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
    // Keyword case is the signal, not identifier case.
    const mixed = scanLookout({ ...base(), brief: "TRUNCATE TABLE SessionLog;" });
    expect(ids(mixed.findings)).toContain("lookout.brief.db-destructive");
    const deleted = scanLookout({ ...base(), brief: "DELETE FROM production_users WHERE disabled = true;" });
    expect(ids(deleted.findings)).toContain("lookout.brief.db-destructive");
    const prose = scanLookout({ ...base(), brief: "copy the records, delete from memory afterwards" });
    expect(ids(prose.findings)).not.toContain("lookout.brief.db-destructive");
    const separateLine = scanLookout({ ...base(), brief: "Do not update docs\nDELETE FROM users;" });
    expect(ids(separateLine.findings)).toContain("lookout.brief.db-destructive");
    for (const brief of [
      "Run `drop table users`;",
      "drop table users;",
      "TRUNCATE users;",
      'DELETE FROM "production_users";',
      "delete from users where inactive = true;",
      "drop table users cascade;",
      "DROP SCHEMA production CASCADE;",
      "DROP SCHEMA production",
      "DELETE\nFROM users;",
      "DROP\nTABLE users;",
    ]) {
      const contextual = scanLookout({ ...base(), brief });
      expect(ids(contextual.findings)).toContain("lookout.brief.db-destructive");
    }
    const incomplete = scanLookout({ ...base(), brief: "DROP TABLE" });
    expect(ids(incomplete.findings)).not.toContain("lookout.brief.db-destructive");
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

  it("flags mirror pushes as destructive", () => {
    const report = scanLookout({ ...base(), brief: "git push --mirror origin" });
    expect(ids(report.findings)).toContain("lookout.brief.force-op");
  });

  it("does not flag the --force-if-includes option as a force push", () => {
    const report = scanLookout({ ...base(), brief: "git push --force-if-includes origin feature" });
    expect(ids(report.findings)).not.toContain("lookout.brief.force-op");
  });

  it("inspects only the refspec destination for protected-branch pushes", () => {
    // main is the *source* here; the destination (feature) is not protected.
    const report = scanLookout({ ...base(), brief: "git push origin main:feature" });
    expect(ids(report.findings)).not.toContain("lookout.brief.protected-branch");
    // inverse of the existing HEAD:main case still holds
    const report2 = scanLookout({ ...base(), brief: "git push origin HEAD:main" });
    expect(ids(report2.findings)).toContain("lookout.brief.protected-branch");
    const tagSource = scanLookout({ ...base(), brief: "git push origin refs/tags/v1:main" });
    expect(ids(tagSource.findings)).not.toContain("lookout.brief.protected-branch");
    const explicitHeads = scanLookout({ ...base(), brief: "git push origin refs/tags/v1:refs/heads/main" });
    expect(ids(explicitHeads.findings)).toContain("lookout.brief.protected-branch");
    const tagShorthand = scanLookout({ ...base(), brief: "git push origin tag main" });
    expect(ids(tagShorthand.findings)).not.toContain("lookout.brief.protected-branch");
  });

  it("flags forced cleans without -d and recognizes dry-run exclusions", () => {
    // git clean -f deletes untracked files without -d
    for (const brief of [
      "git clean -f",
      "git clean -fd",
      "git clean -dfx",
      "git clean -d -f",
      "git clean -n -f",
      "git clean --dry-run --force",
    ]) {
      const report = scanLookout({ ...base(), brief });
      if (brief.includes("dry-run") || brief.includes("-n")) {
        expect(ids(report.findings)).not.toContain("lookout.brief.force-op");
      } else {
        expect(ids(report.findings)).toContain("lookout.brief.force-op");
      }
    }
    // dry runs cannot perform the operation
    for (const brief of ["git clean -nfd", "git clean -n", "git push --dry-run --force origin main"]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).not.toContain("lookout.brief.force-op");
    }
    const mixedClauses = scanLookout({ ...base(), brief: "git clean --dry-run; git reset --hard HEAD~1" });
    expect(ids(mixedClauses.findings)).toContain("lookout.brief.force-op");
    const excludeValue = scanLookout({ ...base(), brief: "git clean -e -n -f" });
    expect(ids(excludeValue.findings)).toContain("lookout.brief.force-op");
    const pathspec = scanLookout({ ...base(), brief: "git clean -f -- -n" });
    expect(ids(pathspec.findings)).toContain("lookout.brief.force-op");
    for (const brief of ["git -C /repo reset --hard HEAD~1", "git reset -q --hard HEAD~1"]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.force-op");
    }
    const resetPathspec = scanLookout({ ...base(), brief: "git reset -- --hard" });
    expect(ids(resetPathspec.findings)).not.toContain("lookout.brief.force-op");
    const previousCleanForce = process.env.CLEAN_FORCE;
    process.env.CLEAN_FORCE = "0";
    try {
      const configEnv = scanLookout({
        ...base(),
        brief: "git --config-env=clean.requireForce=CLEAN_FORCE clean",
      });
      expect(ids(configEnv.findings)).toContain("lookout.brief.force-op");
    } finally {
      if (previousCleanForce === undefined) delete process.env.CLEAN_FORCE;
      else process.env.CLEAN_FORCE = previousCleanForce;
    }
  });

  it("parses full protected-branch refspec destinations", () => {
    // :main (empty source) deletes the remote branch
    for (const brief of ["git push origin :main", "git push origin HEAD:refs/heads/main"]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.protected-branch");
    }
  });

  it("skips dry-run protected-branch pushes", () => {
    const report = scanLookout({ ...base(), brief: "git push --dry-run origin main" });
    expect(ids(report.findings)).not.toContain("lookout.brief.protected-branch");
  });

  it("recognizes the long --force spelling of git clean", () => {
    for (const brief of ["git clean --force", "git clean -d --force", "git clean --force -d"]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.force-op");
    }
  });

  it("inspects every refspec of a multi-refspec push", () => {
    // protected branch is not the first refspec
    for (const brief of [
      "git push origin feature main",
      "git push origin feature refs/heads/main",
      "git push origin --force feature main",
      "git push upstream feature main; git push upstream other thing",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.protected-branch");
    }
    // prose after the command must not become a refspec
    const prose = scanLookout({ ...base(), brief: "git push origin feature, then update main docs" });
    expect(ids(prose.findings)).not.toContain("lookout.brief.protected-branch");
    // non-protected multi-refspec pushes stay silent
    const clean = scanLookout({ ...base(), brief: "git push origin feature other" });
    expect(ids(clean.findings)).not.toContain("lookout.brief.protected-branch");
  });

  it("parses operands before classifying protected destinations", () => {
    // a remote literally named main is a repository operand, not a refspec
    const remote = scanLookout({ ...base(), brief: "git push main" });
    expect(ids(remote.findings)).not.toContain("lookout.brief.protected-branch");
    // value-taking options consume the next token (-o main is a push option)
    const optionValue = scanLookout({ ...base(), brief: "git push -o main origin feature" });
    expect(ids(optionValue.findings)).not.toContain("lookout.brief.protected-branch");
    // ...but the operand after the consumed value is still inspected
    const after = scanLookout({ ...base(), brief: "git push -o ci.skip origin feature main" });
    expect(ids(after.findings)).toContain("lookout.brief.protected-branch");
  });

  it("parses repository options, global options, and attached push values", () => {
    for (const brief of [
      "git push --repo origin main",
      "git push --repo=origin main",
      "git -C /repo push origin main",
      "git push origin main\r\n",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.protected-branch");
    }
    const attachedOption = scanLookout({
      ...base(),
      brief: "git push -on --force origin feature",
    });
    expect(ids(attachedOption.findings)).toContain("lookout.brief.force-op");
  });

  it("recognizes parameterized and bundled force flags", () => {
    for (const brief of [
      "git push --force-with-lease=feature:abc123 origin feature",
      "git push -fu origin feature",
      "git push -fn origin feature", // bundled force AND dry-run: dry run wins
    ]) {
      const report = scanLookout({ ...base(), brief });
      const forceFlagged = ids(report.findings).includes("lookout.brief.force-op");
      if (brief.includes("-fn")) {
        expect(forceFlagged).toBe(false); // dry run cannot perform the push
      } else {
        expect(forceFlagged).toBe(true);
      }
    }
  });

  it("recognizes mixed recursive-force rm spellings", () => {
    for (const brief of [
      "rm -f file.txt",
      "rm -r tree",
      "rm -R -f dir",
      "rm --recursive -f dir",
      "rm -r --force dir",
      "rm -f --recursive dir",
      "rm -RF dir",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.force-op");
    }
  });

  it("tokenizes quoted and Markdown-formatted refspecs", () => {
    for (const brief of [
      "git push origin 'main'",
      'git push origin "main"',
      "run `git push origin main` next",
      "git push origin 'refs/heads/main'",
      "Run `git push origin main`.",
      "Run git push origin main, then continue",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.protected-branch");
    }
  });

  it("keeps connector words inside refspecs", () => {
    const report = scanLookout({ ...base(), brief: "git push origin feature-and-fix:main" });
    expect(ids(report.findings)).toContain("lookout.brief.protected-branch");
  });

  it("does not treat push-option values as dry-run or force flags", () => {
    // -n is the -o value here: this is a real forced update
    const dryRunValue = scanLookout({ ...base(), brief: "git push -o -n origin main --force" });
    expect(ids(dryRunValue.findings)).toContain("lookout.brief.force-op");
    // -f is the -o value here: the command is rejected by git, not forced
    const forceValue = scanLookout({ ...base(), brief: "git push -o -f origin feature" });
    expect(ids(forceValue.findings)).not.toContain("lookout.brief.force-op");
    expect(ids(forceValue.findings)).not.toContain("lookout.brief.protected-branch");
    const quotedValue = scanLookout({
      ...base(),
      brief: "git push -o 'one and two' --force origin feature",
    });
    expect(ids(quotedValue.findings)).toContain("lookout.brief.force-op");
  });

  it("stops tokenizing at clause connectors, not just punctuation", () => {
    const report = scanLookout({ ...base(), brief: "git push origin feature then update main docs" });
    expect(ids(report.findings)).not.toContain("lookout.brief.protected-branch");
  });

  it("joins shell continuations and ignores printed or help commands", () => {
    for (const brief of [
      "git push \\\n+  --force origin feature",
      "git push origin \\\n+  main",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(report.findings.some((finding) => finding.id.startsWith("lookout.brief."))).toBe(true);
    }
    for (const brief of [
      "echo git push --force origin feature",
      "echo rm -rf directory",
      "git --help push --force origin feature",
      "git --version push --force origin feature",
      "git --html-path push --force origin feature",
      "git --man-path push --force origin feature",
      "git --info-path push --force origin feature",
      "git push -F origin feature",
      "git push --force --no-force origin feature",
      "git clean --force --no-force",
      "git -c clean.requireForce=false -c clean.requireForce=true clean",
      "command -v git push --force origin feature",
      "command -V git push --force origin feature",
      "echo 'git reset --hard'",
      "git reset --hard -- README.md",
      "echo foo\\; git push --force origin feature",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(report.findings).toEqual([]);
    }
  });

  it("handles Markdown command lists, code spans, and escaped option values", () => {
    for (const brief of [
      "- git push --force origin feature",
      "* rm -rf build",
      "1. git push origin main",
      "- [ ] git push --force origin feature",
      "sudo -u root git push --force origin feature",
      "env --ignore-environment git push --force origin feature",
      "env -u FOO git push --force origin feature",
      "env -C /repo git push --force origin feature",
      "FOO=\"a b\" git push --force origin feature",
      "command git push --force origin feature",
      "exec git push --force origin feature",
      "exec -a worker git push --force origin feature",
      "bash -c 'git push --force origin feature'",
      "bash -lc 'git push --force origin feature'",
      "sh -c 'rm -rf build'",
      "REMOTE=origin git push $REMOTE --force main",
      "if git push --force origin feature; then continue",
      "Please run git push --force origin feature",
      "git push \"/tmp/remote repo.git\" --force HEAD:main",
      "git status | git push --force origin feature",
      "git status & git push origin main",
      "Run `git status; git push --force origin feature`.",
      "git push -o one\\ and\\ two --force origin feature",
      "git push --receive-pack evil --force origin feature",
      "git push --exec=evil --force origin feature",
      "git push --no-exec origin main",
      "git push -4f origin feature",
      "git push -n --no-dry-run --force origin feature",
      "git push --force-with-lease --no-force origin feature",
      "git clean -n --no-dry-run -f",
      "git -c clean.requireForce=false clean",
      "git -c clean.requireForce=0 clean",
      "git -c CLEAN.REQUIREFORCE=FALSE clean",
      "rm -v -rf build",
      "git push -v --force origin feature",
      "> git push --force origin feature",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(report.findings.some((finding) => finding.id === "lookout.brief.force-op" || finding.id === "lookout.brief.protected-branch")).toBe(true);
    }
    for (const brief of ["rm --help -rf /tmp/x", "rm --version -rf /tmp/x"]) {
      const report = scanLookout({ ...base(), brief });
      expect(report.findings).toEqual([]);
    }
  });

  it("flags direct conventional test paths", () => {
    for (const brief of [
      "Delete src/auth.test.ts",
      "remove tests/auth.spec.ts",
      "delete the tests directory",
      "skip src/auth.test.ts for now",
      "skip the failing test",
      "disable this test",
      "remove the failing test",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).toContain("lookout.brief.test-deletion");
    }
    // non-deletion work on a test file stays silent
    const report = scanLookout({ ...base(), brief: "refactor the helpers in src/auth.test.ts" });
    expect(ids(report.findings)).not.toContain("lookout.brief.test-deletion");
    for (const brief of ["remove the test account", "delete the test environment", "disable the test database"]) {
      const falsePositive = scanLookout({ ...base(), brief });
      expect(ids(falsePositive.findings)).not.toContain("lookout.brief.test-deletion");
    }
  });

  it("honors explicit negation in briefings", () => {
    for (const brief of [
      "Do not skip tests under any circumstances",
      "Never run git reset --hard on the release branch",
      "Never, ever run git reset --hard on the release branch",
      "Do not push into main directly; open a PR instead",
      "You should not git push --force origin feature",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(report.findings).toEqual([]);
    }
    for (const brief of ["Don't forget to git push --force origin feature", "Don't hesitate to rm -rf build"]) {
      const reminder = scanLookout({ ...base(), brief });
      expect(reminder.findings.length).toBeGreaterThan(0);
    }
  });

  it("does not treat approval context as negation and scopes repeated commands", () => {
    const withoutApproval = scanLookout({
      ...base(),
      brief: "Without approval, git reset --hard HEAD",
    });
    expect(ids(withoutApproval.findings)).toContain("lookout.brief.force-op");

    const repeated = scanLookout({
      ...base(),
      brief:
        "Never run git push --force origin feature then run git push --force origin feature",
    });
    expect(ids(repeated.findings)).toContain("lookout.brief.force-op");
  });

  it("does not flag prohibited rm operations but flags later requested ones", () => {
    const report = scanLookout({
      ...base(),
      brief: "Do not rm -f file.txt then rm -f file.txt",
    });
    expect(ids(report.findings)).toContain("lookout.brief.force-op");
  });

  it("requires SQL context before flagging destructive prose", () => {
    for (const brief of [
      "Drop table borders on mobile",
      "truncate long labels to 80 characters",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).not.toContain("lookout.brief.db-destructive");
    }
    // uppercase SQL keywords remain high-confidence signals
    const report = scanLookout({ ...base(), brief: "Run the cleanup: DROP TABLE old_events; then TRUNCATE TABLE session_log;" });
    expect(ids(report.findings)).toContain("lookout.brief.db-destructive");
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
    const prose = scanLookout({ ...base(), brief: "Push this branch into release/v2" });
    expect(ids(prose.findings)).toContain("lookout.brief.protected-branch");
    for (const brief of [
      "Push the Docker image to production",
      "Push metrics to production cluster",
      "Push the Docker image to main registry",
      "Merge the configuration into the main config",
      "Merge the release notes into the production documentation",
    ]) {
      const report = scanLookout({ ...base(), brief });
      expect(ids(report.findings)).not.toContain("lookout.brief.protected-branch");
    }
  });

  it("stays silent on rebasing onto a protected branch and lookalike branches", () => {
    for (const brief of [
      "Rebase this feature branch onto main",
      "truncate only the display label",
      "git push origin release-candidate-notes",
      "Push this branch into release-candidate-notes",
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
    const report = scanLookout({
      ...base(),
      brief: "Update .env.example, .env.local.example, .env.production.template, and .env.dist docs",
    });
    expect(ids(report.findings)).not.toContain("lookout.brief.secrets-touch");
  });

  it("stays silent on routine wording (anti false-positive contract)", () => {
    const report = scanLookout({
      ...base(),
      brief:
        "Add password validation to the signup form, document the auth flow, " +
        "write tests for the migration guide page, truncate the log file " +
        "before capturing fixtures, drop stale table borders in the UI, " +
        "and clean up the docs folder.",
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
    expect(finding?.evidence).toContain(" M base.txt");
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

  it("flags tracked secret paths under non-ASCII directories", () => {
    const dir = makeRepo();
    const nested = join(dir, "秘密");
    mkdirSync(nested);
    writeFileSync(join(nested, ".env"), "SECRET=1\n");
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add nested env"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(report.findings.find((finding) => finding.id === "lookout.ws.secrets-present")?.evidence).toContain(
      "秘密/.env",
    );
  });

  it("does not trim tracked paths before classifying them", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, " .env"), "placeholder\n");
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add leading-space file"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).not.toContain("lookout.ws.secrets-present");
  });

  it("does not flag environment templates as secrets", () => {
    const dir = makeRepo();
    for (const name of [".env.example", ".env.local.example", ".env.production.template", ".env.dist"]) {
      writeFileSync(join(dir, name), "API_KEY=placeholder\n");
      git(dir, ["add", name]);
    }
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env templates"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).not.toContain("lookout.ws.secrets-present");
  });

  it("still flags environment-specific files without a template suffix", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, ".env.local"), "SECRET=1\n");
    git(dir, ["add", ".env.local"]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).toContain("lookout.ws.secrets-present");
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

  it("preserves a repository root that ends with whitespace", () => {
    const parent = mkdtempSync(join(tmpdir(), "omc-lookout-root-"));
    tempDirs.push(parent);
    const dir = join(parent, "repo ");
    mkdirSync(dir);
    git(dir, ["init", "-q"]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"]);
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(report.repo).toBe(dir);
  });

  it("fails closed on a broken repository instead of reporting clear", () => {
    // A .git file pointing at a missing gitdir makes git emit the same
    // "not a git repository" stderr as a plain directory — but a repository
    // exists here, so silence would hide an unreadable state.
    const dir = mkdtempSync(join(tmpdir(), "omc-lookout-broken-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent/omc-lookout-gitdir\n");
    try {
      scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LookoutError);
      expect((error as LookoutError).exitCode).toBe(2);
    }
  });

  it.skipIf(process.platform === "win32")("fails closed on a dangling .git symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "omc-lookout-dangling-"));
    tempDirs.push(dir);
    symlinkSync(join(dir, "missing-gitdir"), join(dir, ".git"));
    try {
      scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LookoutError);
      expect((error as LookoutError).exitCode).toBe(2);
    }
  });

  it("overrides status.showUntrackedFiles=no when listing workspace changes", () => {
    const dir = makeRepo();
    git(dir, ["config", "status.showUntrackedFiles", "no"]);
    writeFileSync(join(dir, "untracked.txt"), "pending\n");
    const report = scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });
    expect(ids(report.findings)).toContain("lookout.ws.dirty-worktree");
  });

  it("ignores inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE when selecting --repo", () => {
    const withSecret = makeRepo();
    writeFileSync(join(withSecret, ".env"), "SECRET=1\n");
    git(withSecret, ["add", ".env"]);
    git(withSecret, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add env"]);
    const clean = makeRepo();
    // Compute the expected toplevel BEFORE the selection variables are
    // exported: the bare helper below does not sanitize them, and a
    // GIT_DIR-inherited rev-parse would return the wrong repo here too.
    const cleanTop = git(clean, ["rev-parse", "--show-toplevel"]);

    const saved = { ...process.env };
    try {
      process.env.GIT_DIR = join(withSecret, ".git");
      process.env.GIT_WORK_TREE = withSecret;
      process.env.GIT_COMMON_DIR = join(withSecret, "missing-common");
      process.env.GIT_OBJECT_DIRECTORY = join(withSecret, "missing-objects");
      // --repo points at the clean repo; inherited variables point at the
      // secret-bearing one. The scan must follow --repo.
      const report = scanLookout({ repo: clean, now: new Date("2026-09-08T00:00:00Z") });
      expect(report.repo).toBe(cleanTop);
      expect(ids(report.findings)).not.toContain("lookout.ws.secrets-present");
      // ...and the explicitly selected repo is scanned correctly.
      const direct = scanLookout({ repo: withSecret, now: new Date("2026-09-08T00:00:00Z") });
      expect(ids(direct.findings)).toContain("lookout.ws.secrets-present");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it.skipIf(process.platform === "win32")("disables fsmonitor during scans", () => {
    const dir = makeRepo();
    const marker = join(dir, "fsmonitor-marker");
    const hook = join(dir, "fsmonitor-hook.cjs");
    writeFileSync(
      hook,
      "require('node:fs').appendFileSync(process.argv[2], 'x'); process.stdout.write('');",
    );
    git(dir, [
      "config",
      "core.fsmonitor",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} ${JSON.stringify(marker)}`,
    ]);

    scanLookout({ repo: dir, now: new Date("2026-09-08T00:00:00Z") });

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(hook)).toBe(true);
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

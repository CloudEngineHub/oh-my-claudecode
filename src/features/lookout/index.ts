/**
 * lookout: pre-flight danger scan for autonomous runs.
 *
 * Before an unattended effort starts (graph run, autopilot, launch, a
 * multi-agent team), lookout scans two inputs:
 *   1. the task briefing text (what the agent is about to be asked to do)
 *   2. the workspace state (what dangerous surfaces already exist)
 * and emits a machine-readable report of findings. High-risk verdicts pair
 * naturally with OMC's approval gates (`omc graph run --approval-mode
 * remote`) and checkpoints (`omc checkpoint create`), but lookout itself is
 * advisory only: it never blocks, never mutates, and has no skip-file
 * backdoor (silence is a whole-feature decision, not a per-run reflex).
 *
 * Design constraints (lessons from the retired risk-assess classifier,
 * see upstream issue #3164):
 * - High-confidence signals only: every rule is mechanically checkable and
 *   reports the exact evidence it matched. No volume heuristics, no
 *   catch-all "unknown means warn" branches, no bare substring matching
 *   on broad tokens (patterns are word- and path-segment-anchored).
 * - Prefer misses over false positives: a lookout that cries wolf trains
 *   users to ignore it, and the protection dies with the habit.
 * - Zero-config: no ignore files, no per-rule toggles. If a scan is noisy,
 *   that is a bug in the rules, not something the user should have to
 *   suppress per run.
 *
 * The finding shape (severity / confidence / actionable) deliberately uses
 * the vocabulary drydock's `--check` audit documents, so a structured
 * contract can later be shared by both surfaces.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";

const GIT_TIMEOUT_MS = 30_000;

export type LookoutSeverity = "high" | "medium" | "low" | "info";
export type LookoutConfidence = "high" | "low";
export type LookoutVerdict = "clear" | "advisory" | "review-recommended";

export interface LookoutFinding {
  /** Stable rule id, namespaced `lookout.<surface>.<signal>`. */
  id: string;
  title: string;
  severity: LookoutSeverity;
  /**
   * "high" = mechanically checkable signal (lookout never reports a finding
   * it cannot point at evidence for); the axis is kept for contract parity
   * with drydock's audit vocabulary.
   */
  confidence: LookoutConfidence;
  actionable: boolean;
  /** Exact matched snippets / paths the finding is based on. */
  evidence: string[];
  /** What to do about it (usually: pair with approval gates / checkpoints). */
  advice: string;
}

export interface LookoutReport {
  scannedAt: string;
  /** Repository root that was scanned, or null when not inside a git repo. */
  repo: string | null;
  briefSource: "flag" | "file" | "none";
  findings: LookoutFinding[];
  summary: {
    counts: Record<LookoutSeverity, number>;
    verdict: LookoutVerdict;
  };
}

export class LookoutError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "LookoutError";
  }
}

const GATE_ADVICE =
  "Pair the run with approval gates: " +
  "`omc graph run --approval-mode remote --checkpoint` so the dangerous " +
  "step waits for explicit human approval.";

const CHECKPOINT_ADVICE =
  "Snapshot the workspace first: `omc checkpoint create --label \"before <task>\"` " +
  "so any bad outcome is one `omc checkpoint rollback <id>` away from undone.";

interface BriefRule {
  id: string;
  title: string;
  severity: Extract<LookoutSeverity, "high" | "medium" | "low">;
  pattern: RegExp;
  advice: string;
}

/**
 * Briefing rules. Every pattern is anchored on the dangerous operation or
 * surface itself (word boundaries, explicit compound phrases) — never on
 * broad tokens like "auth" or "migration" that appear in routine work.
 */
const BRIEF_RULES: BriefRule[] = [
  {
    id: "lookout.brief.force-op",
    title: "Briefing asks for a destructive git/file operation",
    severity: "high",
    pattern:
      /\bgit\s+push\b[^;\n]*?(?:^|[^-\w])(?:--force-with-lease\b|--force\b|-f\b)|\bgit\s+reset\s+--hard\b|\brm\s+-[a-z]*[rf][a-z]*[rf][a-z]*\b|\brm\b[^;\n]*\s-r\b[^;\n]*\s-f\b|\brm\b[^;\n]*\s-f\b[^;\n]*\s-r\b|\brm\b[^;\n]*--(?:recursive|force)\b[^;\n]*--(?:recursive|force)\b|\bgit\s+clean\s+-[a-z]*[fd][a-z]*[fd][a-z]*\b|\bgit\s+clean\b[^;\n]*\s-f\b[^;\n]*\s-d\b|\bgit\s+clean\b[^;\n]*\s-d\b[^;\n]*\s-f\b/gi,
    advice: GATE_ADVICE,
  },
  {
    id: "lookout.brief.db-destructive",
    title: "Briefing asks for destructive database operations",
    severity: "high",
    pattern:
      /\bdrop\s+table\b|\btruncate\s+(?!the\b|this\b|that\b|these\b|those\b|a\b|an\b|your\b|its\b|the\s)(?:table\s+|only\s+)?[a-z_][\w.]*\b|\bdrop\s+column\b|\bdrop\s+database\b/gi,
    advice: GATE_ADVICE,
  },
  {
    id: "lookout.brief.test-deletion",
    title: "Briefing asks to delete, skip, or disable tests",
    severity: "high",
    pattern:
      /\b(?:delete|remove|drop)\s+(?:(?:all|the|existing|failing|flaky|these|unit|integration|e2e|regression)\s+){0,3}tests\b|\b(?:delete|remove|drop)\s+(?:\w+\s+){0,2}test\s+(?:files?|suites?|cases?)\b|\b(?:skip|disable|bypass|ignore)\s+(?:(?:the|all|failing|flaky|unit|integration|e2e|regression)\s+){0,3}tests\b/gi,
    advice: GATE_ADVICE,
  },
  {
    id: "lookout.brief.protected-branch",
    title: "Briefing targets a protected branch directly",
    severity: "high",
    pattern:
      /\b(?:push|merge|force-merge|squash-merge|rebase)\s+(?:\w+\s+){0,3}?(?:to|into|on|against|onto)\s+(?:the\s+)?(?:main|master|release|production|develop)\b|\bdirect(?:ly)?\s+(?:push|commit|merge)\w*\s+(?:\w+\s+){0,2}?(?:to|into|on)\s+(?:the\s+)?(?:main|master|release|production)\b|\bgit\s+push\b(?:\s+\S+){0,3}?\s+(?:origin|upstream)\s+(?:\S*[:/])?(?:main|master|release|production|develop)\b/gi,
    advice: GATE_ADVICE,
  },
  {
    id: "lookout.brief.secrets-touch",
    title: "Briefing touches secret material (.env, keys, credentials)",
    severity: "medium",
    pattern:
      /\.env(?!\.(?:example|sample|template|dist))\b|\bapi[-_ ]?keys?\b|\bprivate[-_ ]?keys?\b|\bcredentials?\b|\bsecrets?\b/gi,
    advice:
      "Secret surfaces are easy to leak and hard to un-leak. If the task " +
      "really needs to read or change them, " + GATE_ADVICE,
  },
  {
    id: "lookout.brief.ci-touch",
    title: "Briefing modifies CI/CD configuration",
    severity: "medium",
    pattern:
      /\bgithub\s+actions?\b|\bgitlab[- ]?ci\b|\bjenkinsfile\b|\.github\/workflows\b|\bci\s+(?:workflow|pipeline|config|job|yml|yaml)s?\b/gi,
    advice:
      "CI changes silently widen what future runs can do. If intended, " +
      GATE_ADVICE,
  },
  {
    id: "lookout.brief.deploy-touch",
    title: "Briefing modifies deployment/infrastructure configuration",
    severity: "medium",
    pattern:
      /\b(?:deploy|deployment|k8s|kubernetes|helm|terraform|infra|staging|production)\s+(?:config|configuration|manifest|definition|yml|yaml|file|script|infra(?:structure)?|cluster|environment)s?\b|\b(?:deploy|infra|k8s|kubernetes|helm|terraform)\//gi,
    advice:
      "Deployment changes can be irreversible once shipped. If intended, " +
      GATE_ADVICE,
  },
];

/** Returns the distinct matches of a global regex, trimmed for evidence. */
function collectMatches(text: string, pattern: RegExp, limit = 3): string[] {
  const out: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  for (const match of text.matchAll(re)) {
    const snippet = match[0].replace(/\s+/g, " ").trim();
    if (snippet && !out.includes(snippet)) out.push(snippet);
    if (out.length >= limit) break;
  }
  return out;
}

interface GitFailure {
  stderr: string;
  code?: string | number;
}

function runGit(args: string[], cwd: string): string {
  try {
    // --no-optional-locks keeps the scan read-only: `git status` would
    // otherwise refresh and rewrite .git/index (and can take the index
    // lock during concurrent automation). Same approach as the HUD
    // status reader (src/hud/elements/git.ts).
    return execFileSync("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as GitFailure;
    const stderr = String(failure.stderr ?? "");
    throw new LookoutError(`git ${args[0]} failed in ${cwd}: ${stderr.trim() || "unknown error"}`, 2);
  }
}

/**
 * Returns the repository root, or null when the directory is simply not a
 * git repository. Any other git failure (missing binary, unreadable path,
 * timeout) is a scan error and fails closed with exit code 2 instead of
 * masquerading as a finding-free scan.
 */
function repoRoot(repoArg: string): string | null {
  let top: string;
  try {
    top = execFileSync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], {
      cwd: repoArg,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as GitFailure;
    const stderr = String(failure.stderr ?? "");
    if (/not a git repository/i.test(stderr)) return null;
    if (failure.code === "ENOENT") {
      throw new LookoutError(
        `Cannot scan "${repoArg}": the directory does not exist (or the git executable is unavailable).`,
        2,
      );
    }
    throw new LookoutError(`git rev-parse failed in ${repoArg}: ${stderr.trim() || "unknown error"}`, 2);
  }
  return top.trim();
}

/**
 * Tracked secret-looking files. Environment *templates* (.env.example and
 * friends) hold placeholders by convention, not secrets, so they are
 * excluded — lookout has no ignore mechanism, and a template would be a
 * permanent false positive in every repo that tracks one.
 */
const SECRETS_PATH =
  /(?:^|\/)\.env(?!\.(?:example|sample|template|dist)\b)(?:\..+)?$|(?:^|\/)secrets?\.(?:json|ya?ml|txt)$|(?:^|\/)secrets?\//i;

function scanWorkspace(root: string): LookoutFinding[] {
  const findings: LookoutFinding[] = [];

  const tracked = runGit(["ls-files"], root);
  if (tracked) {
    const secretPaths = tracked
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => SECRETS_PATH.test(line))
      .slice(0, 5);
    if (secretPaths.length > 0) {
      findings.push({
        id: "lookout.ws.secrets-present",
        title: "Tracked secret-looking files exist in the repository",
        severity: "medium",
        confidence: "high",
        actionable: true,
        evidence: secretPaths,
        advice:
          "Agents can read these by default. Keep the task away from them, or " +
          "if the run must touch them, " + GATE_ADVICE,
      });
    }
  }

  const status = runGit(["status", "--porcelain"], root);
  if (status && status.trim().length > 0) {
    const lines = status.trim().split("\n").slice(0, 5);
    findings.push({
      id: "lookout.ws.dirty-worktree",
      title: "Working tree has uncommitted changes",
      severity: "low",
      confidence: "high",
      actionable: true,
      evidence: lines,
      advice: CHECKPOINT_ADVICE,
    });
  }

  return findings;
}

function computeSummary(findings: LookoutFinding[]): LookoutReport["summary"] {
  const counts: Record<LookoutSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  const verdict: LookoutVerdict =
    counts.high > 0
      ? "review-recommended"
      : counts.medium > 0 || counts.low > 0
        ? "advisory"
        : "clear";
  return { counts, verdict };
}

export interface ScanLookoutOptions {
  /** Directory to scan (defaults to process.cwd() at the CLI layer). */
  repo: string;
  /** Briefing text to scan; omit to scan workspace state only. */
  brief?: string;
  /** Where the brief came from (report metadata only). */
  briefSource?: LookoutReport["briefSource"];
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Runs every lookout rule over the given inputs and returns the full report.
 * Read-only by construction: the only filesystem/git access is reading
 * tracked-file lists and status output.
 */
export function scanLookout(options: ScanLookoutOptions): LookoutReport {
  const findings: LookoutFinding[] = [];

  const brief = options.brief;
  if (brief !== undefined) {
    for (const rule of BRIEF_RULES) {
      const evidence = collectMatches(brief, rule.pattern);
      if (evidence.length > 0) {
        findings.push({
          id: rule.id,
          title: rule.title,
          severity: rule.severity,
          confidence: "high",
          actionable: true,
          evidence,
          advice: rule.advice,
        });
      }
    }
  }

  const root = repoRoot(options.repo);
  if (root) findings.push(...scanWorkspace(root));

  return {
    scannedAt: (options.now ?? new Date()).toISOString(),
    repo: root,
    briefSource: options.briefSource ?? (brief === undefined ? "none" : "flag"),
    findings,
    summary: computeSummary(findings),
  };
}

/** Loads a briefing from `@path` (or returns inline text unchanged). */
export function resolveBriefArg(briefArg: string): { text: string; source: LookoutReport["briefSource"] } {
  if (!briefArg.startsWith("@")) return { text: briefArg, source: "flag" };
  const path = isAbsolute(briefArg.slice(1)) ? briefArg.slice(1) : join(resolve(process.cwd()), briefArg.slice(1));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new LookoutError(`Cannot read briefing file ${path}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  return { text, source: "file" };
}

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
import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

const GIT_TIMEOUT_MS = 30_000;
/**
 * Deliberate output ceiling for the read-only git calls: Node's 1 MiB
 * default kills `git ls-files` on large repositories with ENOBUFS (scan
 * error instead of a report). 16 MiB comfortably covers tracked-file
 * listings and porcelain status for any repository OMC operates in.
 */
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

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
  /**
   * Lines matching this pattern are skipped before the rule runs — for
   * example dry-run demonstrations, which cannot perform the operation
   * they name and must not produce high-severity findings.
   */
  excludedPattern?: RegExp;
  /**
   * Optional code-level scanner for signals a single regex cannot express
   * (e.g. inspecting every refspec of a push command, not just the first).
   * Returns evidence snippets for the line; each is still subject to the
   * same negation check as regex matches.
   */
  collect?: (line: string) => string[];
}

/**
 * Bounded negation handling: a briefing that *forbids* a dangerous action
 * ("Do not skip tests", "Never run git reset --hard") must not be flagged
 * for requesting it. A match is ignored when a negation cue appears within
 * 48 characters before it on the same line — close enough to be a
 * prohibition, far enough that unrelated mentions don't mask real ones.
 */
const NEGATION_CUE = /\b(?:do\s+not|don't|dont|never|avoid|must\s+not|without|prohibited)\b/gi;

function isNegated(line: string, matchIndex: number): boolean {
  for (const cue of line.matchAll(NEGATION_CUE)) {
    if (cue.index !== undefined && matchIndex >= cue.index && matchIndex - cue.index < 48) {
      return true;
    }
  }
  return false;
}

/**
 * Protected destinations and force flags for `git push` lines, one evidence
 * snippet per offending operand. Grammar (git-push(1)): `git push [<options>]
 * [<repository> [<refspec>...]]` — flags are skipped (value-taking options
 * consume the following token), the first non-flag token is the repository,
 * and every remaining non-flag token is a refspec. Because classification is
 * operand-based, a push-option value can never masquerade as a dry-run or
 * force flag (`git push -o -n origin main --force` is a real forced update).
 * Tokenizing stops at anything that does not look like a command word or at
 * a clause connector, so trailing prose ("... origin feature, then update
 * main docs") cannot turn prose into a refspec.
 */
const PROTECTED_BRANCH_NAME = /^(?:main|master|develop|release(?:\/[\w./-]+)?|production(?:\/[\w./-]+)?)$/;
const COMMAND_WORD = /^[A-Za-z0-9_./+:@~^=-]+$/;
/** Push options that consume the following token as a value. */
const PUSH_VALUE_OPTION = /^(?:-o|--push-option|--repo)$/;
const PUSH_DRY_RUN_FLAG = /^(?:-n|--dry-run)$/;
const PUSH_FORCE_FLAG = /^(?:-f|--force|--force-with-lease|--mirror)$/;
/** Words that typically begin trailing prose after a command. */
const CLAUSE_CONNECTOR = /^(?:then|and|but|also|after|before|while|because|so|which|plus)$/i;

interface ParsedPush {
  /** Genuine flags — option values never land here. */
  flags: string[];
  /** First non-flag operand, or null. */
  repo: string | null;
  /** Refspecs: every non-flag operand after the repository. */
  refspecs: string[];
}

function parsePushCommand(segment: string): ParsedPush | null {
  const push = /\bgit\s+push\b/.exec(segment);
  if (!push) return null;
  const tokens = segment.slice((push.index ?? 0) + push[0].length).split(/\s+/).filter(Boolean);
  const parsed: ParsedPush = { flags: [], repo: null, refspecs: [] };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    i += 1;
    if (!COMMAND_WORD.test(token)) break; // prose begins here
    if (token.startsWith("-")) {
      if (PUSH_VALUE_OPTION.test(token)) i += 1; // consume the option value
      else parsed.flags.push(token);
      continue;
    }
    if (CLAUSE_CONNECTOR.test(token)) break; // prose begins here
    if (parsed.repo === null) parsed.repo = token;
    else parsed.refspecs.push(token);
  }
  return parsed;
}

function isPushDryRun(parsed: ParsedPush): boolean {
  return parsed.flags.some((flag) => PUSH_DRY_RUN_FLAG.test(flag));
}

/** Force/mirror pushes and `+`-prefixed refspecs, as evidence snippets. */
function collectPushForceOps(line: string): string[] {
  const hits: string[] = [];
  // Semicolons and &&/|| separate commands; each segment is parsed alone.
  for (const segment of line.split(/;|&&|\|\|/)) {
    const parsed = parsePushCommand(segment);
    if (!parsed || isPushDryRun(parsed)) continue;
    for (const flag of parsed.flags) {
      if (PUSH_FORCE_FLAG.test(flag)) {
        hits.push(flag);
        break;
      }
    }
    for (const refspec of parsed.refspecs) {
      if (refspec.startsWith("+")) {
        hits.push(refspec);
        break;
      }
    }
  }
  return hits;
}

function collectProtectedPushDests(line: string): string[] {
  const hits: string[] = [];
  for (const segment of line.split(/;|&&|\|\|/)) {
    const parsed = parsePushCommand(segment);
    if (!parsed || isPushDryRun(parsed)) continue;
    for (const refspec of parsed.refspecs) {
      // Refspec: [+][src:]dst — destination is the side after the last
      // colon, with an optional refs/heads/ prefix.
      const bare = refspec.replace(/^\+/, "");
      const dest = (bare.includes(":") ? bare.slice(bare.lastIndexOf(":") + 1) : bare).replace(
        /^refs\/heads\//,
        "",
      );
      if (PROTECTED_BRANCH_NAME.test(dest)) hits.push(refspec);
    }
  }
  return hits;
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
    // Non-push operations only: command-shaped pushes are classified by the
    // operand parser (collect below), because a bare regex cannot tell a
    // force flag from a push-option value (`git push -o -f origin feature`).
    pattern:
      /\bgit\s+reset\s+--hard\b|\brm\s+-[a-z]*[rf][a-z]*[rf][a-z]*\b|\brm\b[^;\n]*\s-r\b[^;\n]*\s-f\b|\brm\b[^;\n]*\s-f\b[^;\n]*\s-r\b|\brm\b[^;\n]*--(?:recursive|force)\b[^;\n]*--(?:recursive|force)\b|\bgit\s+clean\s+-(?![\w-]*n)[\w]*f[\w]*\b|\bgit\s+clean\b[^;\n]*\s(?:-f(?![\w-])|--force(?![\w-]))\b/gi,
    advice: GATE_ADVICE,
    // Dry runs cannot perform the operation they name. `-n` only counts for
    // git clean here — a push's `-n` may be a push-option value, which the
    // operand parser resolves.
    excludedPattern: /\bgit\s+clean\b[^;\n]*\s-n(?![\w-])|\bgit\b[^;\n]*--dry-run\b/i,
    // Command-shaped pushes: force flags, --mirror, and `+`-prefixed
    // refspecs, with push-option values and dry runs handled by the parser.
    collect: collectPushForceOps,
  },
  {
    id: "lookout.brief.db-destructive",
    title: "Briefing asks for destructive database operations",
    severity: "high",
    // Case-sensitive SQL keywords on purpose: "drop table borders" and
    // "truncate long labels" are English prose, not SQL. Uppercase (or a
    // quoted/statement context) is the high-confidence signal. The keyword
    // carries the case sensitivity — the identifier may be any case
    // (TRUNCATE TABLE Users is valid SQL).
    advice: GATE_ADVICE,
    pattern:
      /\bDROP\s+(?:TABLE|DATABASE)\b|\bDROP\s+COLUMN\b|\bTRUNCATE\s+(?:TABLE\s+|ONLY\s+){0,2}(?:IF\s+EXISTS\s+)?[A-Za-z_][\w.]*\b/g,
  },
  {
    id: "lookout.brief.test-deletion",
    title: "Briefing asks to delete, skip, or disable tests",
    severity: "high",
    // Covers plural "tests", "test files/suites/cases" phrases, and direct
    // conventional test paths (src/auth.test.ts, tests/auth.spec.ts).
    pattern:
      /\b(?:delete|remove|drop)\s+(?:(?:all|the|existing|failing|flaky|these|unit|integration|e2e|regression)\s+){0,3}tests\b|\b(?:delete|remove|drop)\s+(?:\w+\s+){0,2}test\s+(?:files?|suites?|cases?)\b|\b(?:skip|disable|bypass|ignore)\s+(?:(?:the|all|failing|flaky|unit|integration|e2e|regression)\s+){0,3}tests\b|\b(?:delete|remove|drop|skip|disable|bypass|ignore)\s+(?:\w+\s+){0,2}[\w./@~-]*\.(?:test|spec)\.[cm]?[jt]sx?\b|\b(?:delete|remove|drop)\s+(?:the\s+)?(?:tests?|__tests?__|specs?|e2e)\s+(?:directory|folder|tree)\b/gi,
    advice: GATE_ADVICE,
  },
  {
    id: "lookout.brief.protected-branch",
    title: "Briefing targets a protected branch directly",
    severity: "high",
    // Prose forms only — command-shaped pushes (`git push ...`) are handled
    // by the tokenizer below, which parses operands instead of guessing at
    // token roles (a remote can be named main; value-taking options consume
    // the next token).
    pattern:
      /\b(?:push|merge|force-merge|squash-merge)\s+(?:\w+\s+){0,3}?(?:to|into|on|against|onto)\s+(?:the\s+)?(?:main|master|release|production|develop)\b|\bdirect(?:ly)?\s+(?:push|commit|merge)\w*\s+(?:\w+\s+){0,2}?(?:to|into|on)\s+(?:the\s+)?(?:main|master|release|production)\b/gi,
    advice: GATE_ADVICE,
    // A push may carry several refspecs (`git push origin feature main`
    // updates both), so every operand-parsed refspec destination is
    // inspected; dry-run pushes are silenced inside the parser.
    collect: collectProtectedPushDests,
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

interface GitFailure {
  stderr: string;
  code?: string | number;
}

/**
 * Repository-selection variables are stripped before every child git call:
 * when lookout runs inside Git-driven automation that exports GIT_DIR,
 * GIT_WORK_TREE, or GIT_INDEX_FILE, the `--repo` argument would otherwise
 * not select the state actually scanned (child git would report a different
 * repository than the one under the given cwd).
 */
function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  return env;
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
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: sanitizedGitEnv(),
    });
  } catch (error) {
    const failure = error as GitFailure;
    const stderr = String(failure.stderr ?? "");
    throw new LookoutError(`git ${args[0]} failed in ${cwd}: ${stderr.trim() || "unknown error"}`, 2);
  }
}

/**
 * Whether the directory (or any ancestor) carries a `.git` entry. Used to
 * distinguish a plain non-repository from a *broken* one: a `.git` file
 * pointing at a missing gitdir makes git fail with the same "not a git
 * repository" stderr as an ordinary directory, but reporting that as a
 * clear scan would hide the fact that a repository exists here and could
 * not be read.
 */
function hasGitEntry(dir: string): boolean {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Returns the repository root, or null only when there is genuinely no
 * repository (no `.git` entry here or in any ancestor). Any other git
 * failure — including a broken repository, whose stderr contains the same
 * "not a git repository" text — fails closed with exit code 2 instead of
 * masquerading as a finding-free scan.
 */
function repoRoot(repoArg: string): string | null {
  let top: string;
  try {
    top = execFileSync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], {
      cwd: repoArg,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: sanitizedGitEnv(),
    });
  } catch (error) {
    const failure = error as GitFailure;
    const stderr = String(failure.stderr ?? "");
    if (/not a git repository/i.test(stderr)) {
      if (hasGitEntry(repoArg)) {
        throw new LookoutError(
          `Cannot scan "${repoArg}": a repository exists here but git could not read it (${stderr.trim()}).`,
          2,
        );
      }
      return null;
    }
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

  // -uall overrides a repository-local status.showUntrackedFiles=no, which
  // would otherwise hide untracked files and report a clean workspace.
  const status = runGit(["status", "--porcelain", "-uall"], root);
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
    // Rules evaluate line by line: dry-run exclusion and negation handling
    // are per-line judgments, and a briefing rarely mixes requests and
    // prohibitions on one line.
    for (const rule of BRIEF_RULES) {
      const evidence: string[] = [];
      for (const line of brief.split("\n")) {
        if (rule.excludedPattern?.test(line)) continue;
        const re = new RegExp(rule.pattern.source, rule.pattern.flags);
        for (const match of line.matchAll(re)) {
          if (match.index !== undefined && isNegated(line, match.index)) continue;
          const snippet = match[0].replace(/\s+/g, " ").trim();
          if (snippet && !evidence.includes(snippet)) evidence.push(snippet);
          if (evidence.length >= 3) break;
        }
        if (rule.collect) {
          for (const snippet of rule.collect(line)) {
            const at = line.indexOf(snippet);
            if (at >= 0 && isNegated(line, at)) continue;
            if (!evidence.includes(snippet)) evidence.push(snippet);
            if (evidence.length >= 3) break;
          }
        }
        if (evidence.length >= 3) break;
      }
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

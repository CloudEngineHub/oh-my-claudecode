/**
 * lookout command - pre-flight danger scan for autonomous runs.
 *
 * Thin CLI adapter only: all scanning logic lives in
 * src/features/lookout/index.ts. lookout is advisory by design: a scan
 * never blocks anything. Exit code contract (machine-readable, mirrors the
 * drydock follow-up wording):
 *   0 = scan ran, no high-severity findings (with or without --strict)
 *   1 = --strict and the verdict is review-recommended
 *   2 = usage or scan error
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  LookoutError,
  resolveBriefArg,
  scanLookout,
  type LookoutReport,
  type LookoutSeverity,
} from '../features/lookout/index.js';

const VERDICT_LABEL: Record<LookoutReport['summary']['verdict'], string> = {
  clear: 'clear — no danger signals',
  advisory: 'advisory — review the notes below when convenient',
  'review-recommended': 'review recommended — high-risk signals present',
};

const SEVERITY_BADGE: Record<LookoutSeverity, string> = {
  high: chalk.red('HIGH'),
  medium: chalk.yellow('MED '),
  low: chalk.cyan('LOW '),
  info: chalk.gray('INFO'),
};

function errorMessage(error: unknown): string {
  if (error instanceof LookoutError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string, code: number): void {
  console.error(chalk.red(`Error: ${message}`));
  process.exitCode = code;
}

function printHuman(report: LookoutReport): void {
  console.log(chalk.bold('🚨 lookout report'));
  console.log(
    `verdict: ${chalk.bold(VERDICT_LABEL[report.summary.verdict])}` +
      ` (high: ${report.summary.counts.high}, medium: ${report.summary.counts.medium},` +
      ` low: ${report.summary.counts.low})`,
  );
  if (report.findings.length === 0) {
    console.log('No danger signals found. lookout is advisory — it never blocks a run.');
    return;
  }
  for (const finding of report.findings) {
    console.log('');
    console.log(`${SEVERITY_BADGE[finding.severity]}  ${chalk.bold(finding.title)}  ${chalk.dim(finding.id)}`);
    for (const item of finding.evidence) {
      console.log(`    evidence: ${chalk.italic(item.length > 120 ? `${item.slice(0, 117)}...` : item)}`);
    }
    console.log(`    advice: ${finding.advice}`);
  }
  console.log('');
}

/**
 * Returns the `lookout` command:
 *
 *   omc lookout scan [--brief <text|@file>] [--json] [--strict] [--repo <dir>]
 */
export function lookoutCommand(): Command {
  const command = new Command('lookout');
  command.description('Pre-flight danger scan for autonomous runs (advisory only, never blocks)');

  command
    .command('scan')
    .description('Scan a task briefing and/or the workspace for danger signals')
    .option('--brief <text|@file>', 'Task briefing text, or @path to a briefing file')
    .option('--repo <dir>', 'Repository to scan (defaults to cwd)', process.cwd())
    .option('--json', 'Emit the machine-readable report (findings/severity/confidence contract)')
    .option('--strict', 'Exit 1 when the verdict is review-recommended (for scripts that want to pause)')
    .action((options: { brief?: string; repo: string; json?: boolean; strict?: boolean }) => {
      try {
        let brief: string | undefined;
        let briefSource: LookoutReport['briefSource'] = 'none';
        if (options.brief !== undefined) {
          const resolved = resolveBriefArg(options.brief);
          brief = resolved.text;
          briefSource = resolved.source;
        }
        const report = scanLookout({ repo: options.repo, brief, briefSource });
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          printHuman(report);
        }
        if (options.strict && report.summary.verdict === 'review-recommended') {
          process.exitCode = 1;
        }
      } catch (error) {
        fail(errorMessage(error), error instanceof LookoutError ? error.exitCode : 1);
      }
    });

  return command;
}

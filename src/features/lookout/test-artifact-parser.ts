/** Narrow parser for direct rm commands targeting conventional test artifacts. */

export interface TestArtifactMatch {
  snippet: string;
  index: number;
}

const TEST_ARTIFACT = /^(?:tests?\/|__tests__\/|.+\.(?:test|spec)\.[cm]?[jt]sx?$)/i;

export function collectRmTestArtifacts(line: string, depth = 0): TestArtifactMatch[] {
  const matches: TestArtifactMatch[] = [];
  let clauseStart = 0;
  for (let index = 0; index <= line.length; index += 1) {
    const separator = index === line.length || /[;&|]/.test(line[index] ?? "");
    if (!separator) continue;
    const clause = line.slice(clauseStart, index);
    const leading = clause.match(/^\s*[({]?\s*(?:(?:command|exec)\s+|env\s+(?:[A-Za-z_]\w*=\S+\s+)*|sudo\s+)*(?:[\w.-]+\/)?rm\b/i);
    if (leading) {
      const rest = clause.slice(leading[0].length).trim();
      if (/(?:^|\s)(?:-h|--help|--version)(?:\s|$)/.test(rest)) {
        clauseStart = index + 1;
        continue;
      }
      for (const operand of rest.split(/\s+/)) {
        if (operand === "--" || /^-[A-Za-z]+$/.test(operand)) continue;
        const path = operand.replace(/^['"]|['"]$/g, "").replace(/^(?:\.\/)+/, "");
        if (TEST_ARTIFACT.test(path)) {
          matches.push({ snippet: `rm ${path}`, index: clauseStart + clause.indexOf(operand) });
        }
      }
    }
    clauseStart = index + 1;
  }
  if (depth < 8) {
    const shell = /\b(?:bash|sh|dash|zsh|ksh)\b[^;&|\n]*\s(?:-c|--command)\s+(['"])([\s\S]*?)\1/g;
    for (const match of line.matchAll(shell)) {
      const body = match[2] ?? "";
      const bodyIndex = (match.index ?? 0) + (match[0]?.indexOf(body) ?? 0);
      for (const nested of collectRmTestArtifacts(body, depth + 1)) {
        matches.push({ snippet: nested.snippet, index: bodyIndex + nested.index });
      }
    }
  }
  return matches;
}

/** Narrow parser for direct rm commands targeting conventional test artifacts. */

export interface TestArtifactMatch {
  snippet: string;
  index: number;
}

const TEST_ARTIFACT = /^(?:tests?\/|__tests__\/|.+\.(?:test|spec)\.[cm]?[jt]sx?$)/i;

export function collectRmTestArtifacts(line: string): TestArtifactMatch[] {
  const matches: TestArtifactMatch[] = [];
  let clauseStart = 0;
  for (let index = 0; index <= line.length; index += 1) {
    const separator = index === line.length || /[;&|]/.test(line[index] ?? "");
    if (!separator) continue;
    const clause = line.slice(clauseStart, index);
    const leading = clause.match(/^\s*[({]?\s*rm\b/i);
    if (leading) {
      const rest = clause.slice(leading[0].length).trim();
      for (const operand of rest.split(/\s+/)) {
        if (operand === "--" || /^-[A-Za-z]+$/.test(operand)) continue;
        const path = operand.replace(/^['"]|['"]$/g, "");
        if (TEST_ARTIFACT.test(path)) {
          matches.push({ snippet: `rm ${path}`, index: clauseStart + clause.indexOf(operand) });
        }
      }
    }
    clauseStart = index + 1;
  }
  return matches;
}

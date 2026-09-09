/** Narrow parser for rm commands targeting conventional test artifacts. */

import { findExecutableIndex, splitCommandClauses, tokenizeCommand } from "./command-parser.js";
import { decodeAnsiCQuote, findNestedSubstitutions } from "./substitution-parser.js";

export interface TestArtifactMatch {
  snippet: string;
  index: number;
}

const TEST_ARTIFACT = /^(?:tests?\/|__tests__\/|.+\.(?:test|spec)\.[cm]?[jt]sx?$)/i;

function collectNestedShellBodies(line: string, depth: number): TestArtifactMatch[] {
  if (depth >= 8) return [];
  const matches: TestArtifactMatch[] = [];
  const scan = (pattern: RegExp, decode = false, bodyGroup = 2): void => {
    for (const match of line.matchAll(pattern)) {
      const rawBody = match[bodyGroup] ?? "";
      const body = decode ? decodeAnsiCQuote(rawBody) : rawBody;
      const bodyIndex = (match.index ?? 0) + (match[0]?.indexOf(rawBody) ?? 0);
      for (const nested of collectRmTestArtifacts(body, depth + 1)) {
        matches.push({ snippet: nested.snippet, index: bodyIndex + nested.index });
      }
    }
  };
  scan(/\b(?:bash|sh|dash|zsh|ksh)\b[^;&|\n]*\s(?:-c|--command)\s+(['"])([\s\S]*?)\1/g);
  scan(/\b(?:bash|sh|dash|zsh|ksh)\b[^;&|\n]*\s(?:-c|--command)\s+\$'((?:\\.|[^'])*)'/g, true, 1);
  for (const substitution of findNestedSubstitutions([{ text: line, index: 0 }])) {
    for (const nested of collectRmTestArtifacts(substitution.text, depth + 1)) {
      matches.push({ snippet: nested.snippet, index: substitution.index + nested.index });
    }
  }
  return matches;
}

export function collectRmTestArtifacts(line: string, depth = 0): TestArtifactMatch[] {
  const matches: TestArtifactMatch[] = [];
  for (const clause of splitCommandClauses(line)) {
    const tokens = tokenizeCommand(clause.text);
    const rmIndex = findExecutableIndex(tokens, "rm");
    if (rmIndex < 0) continue;
    let operandsOnly = false;
    for (const token of tokens.slice(rmIndex + 1)) {
      if (token.value === "--") {
        operandsOnly = true;
        continue;
      }
      if (!operandsOnly && /^(?:-h|--help|--version)$/.test(token.value)) break;
      if (!operandsOnly && /^-[A-Za-z]+$/.test(token.value)) continue;
      const path = token.value.replace(/^(?:\.\/)+/, "");
      if (TEST_ARTIFACT.test(path)) matches.push({ snippet: `rm ${path}`, index: clause.index + token.index });
    }
  }
  return [...matches, ...collectNestedShellBodies(line, depth)];
}

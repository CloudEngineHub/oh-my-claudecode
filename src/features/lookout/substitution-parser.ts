/** Quote-aware shell substitution discovery for lookout command parsing. */

export interface SubstitutionClause {
  text: string;
  index: number;
}

function isEscapedByOddBackslashes(text: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function findSubstitutionEnd(text: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = start + 2; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function findNestedSubstitutions(clauses: readonly SubstitutionClause[]): Array<{ text: string; index: number }> {
  const nested: Array<{ text: string; index: number }> = [];
  for (const clause of clauses) {
    let quote: "'" | '"' | null = null;
    for (let index = 0; index < clause.text.length; index += 1) {
      const character = clause.text[index] ?? "";
      if (quote === "'") {
        if (character === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (character === "\\") {
          index += 1;
          continue;
        }
        if (character === '"' && !isEscapedByOddBackslashes(clause.text, index)) quote = null;
      } else if (character === "'") {
        quote = "'";
      } else if (character === '"') {
        quote = '"';
      }
      if (quote === "'") continue;
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (clause.text.startsWith("$(", index)) {
        const end = findSubstitutionEnd(clause.text, index);
        if (end >= 0) {
          nested.push({ text: clause.text.slice(index + 2, end), index: clause.index + index + 2 });
          index = end;
        }
      } else if (quote === null && (clause.text.startsWith("<(", index) || clause.text.startsWith(">(", index))) {
        const end = findSubstitutionEnd(clause.text, index);
        if (end >= 0) {
          nested.push({ text: clause.text.slice(index + 2, end), index: clause.index + index + 2 });
          index = end;
        }
      } else if (character === "`") {
        const end = clause.text.indexOf("`", index + 1);
        if (end >= 0) {
          nested.push({ text: clause.text.slice(index + 1, end), index: clause.index + index + 1 });
          index = end;
        }
      }
    }
  }
  return nested;
}

import type { RpDatabase } from "../state/sqlite.ts";
import { searchLoreRows } from "./sqlite.ts";

export type LoreSearchQuery = {
  query: string;
  kind?: string;
  limit?: number;
};

export type LoreSearchResult = {
  id: string;
  kind: string;
  name: string;
  summary: string;
  reason: string;
  score: number;
};

const MIN_SCORE = 52;
const DEFAULT_LIMIT = 5;

export function searchLore(db: RpDatabase, worldName: string, input: LoreSearchQuery): LoreSearchResult[] {
  const query = normalizeSearchText(input.query);
  const terms = splitSearchTerms(input.query);
  if (query.length === 0 || terms.length === 0) {
    return [];
  }

  const limit = input.limit === undefined ? DEFAULT_LIMIT : Math.max(1, Math.floor(input.limit));
  const kindFilter = input.kind?.trim();
  const results: LoreSearchResult[] = [];

  for (const row of searchLoreRows(db, worldName)) {
    if (kindFilter && row.kind !== kindFilter) {
      continue;
    }

    const scored = scoreRow(row, query, terms);
    if (!scored) {
      continue;
    }
    const score = scored.score + (kindFilter && row.kind === kindFilter ? 8 : 0);
    if (score < MIN_SCORE) {
      continue;
    }
    results.push({
      id: row.id,
      kind: row.kind,
      name: row.name,
      summary: row.summary,
      reason: scored.reason,
      score
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function formatLoreLookupResults(results: LoreSearchResult[]): string {
  if (results.length === 0) {
    return "没有找到固定资料。";
  }
  return results
    .map((result) => [`### [${result.kind}] ${result.name} - ${result.id}（${result.reason}）`, result.summary].join("\n"))
    .join("\n\n");
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s.\-_,，。;；:：!?！？()[\]{}（）【】《》"'`~、/\\|]+/gu, "");
}

type SearchableRow = ReturnType<typeof searchLoreRows>[number];

function scoreRow(row: SearchableRow, query: string, terms: string[]): { score: number; reason: string } | undefined {
  const id = normalizeSearchText(row.id);
  const name = normalizeSearchText(row.name);
  const aliases = row.aliases.map(normalizeSearchText);
  const tags = row.tags.map(normalizeSearchText);
  const longText = normalizeSearchText([row.summary, row.body, JSON.stringify(row.fields)].join(" "));

  let best: { score: number; reason: string } | undefined;
  best = takeBest(best, id === query ? { score: 100, reason: "id 精确匹配" } : undefined);
  best = takeBest(best, name === query || aliases.some((alias) => alias === query) ? { score: 96, reason: "名称/别名精确匹配" } : undefined);
  best = takeBest(
    best,
    name.includes(query) || aliases.some((alias) => alias.includes(query)) ? { score: 92, reason: "名称/别名包含匹配" } : undefined
  );
  best = takeBest(best, allTermsIn(terms, tags.join(" ")) ? { score: 88, reason: "标签全部命中" } : undefined);
  best = takeBest(best, allTermsIn(terms, longText) ? { score: 84, reason: "正文全部命中" } : undefined);

  const partialMatches = terms.filter((term) => row.normalizedText.includes(term)).length;
  if (partialMatches > 0) {
    best = takeBest(best, {
      score: 48 + Math.round((partialMatches / terms.length) * 28),
      reason: partialMatches === terms.length ? "别名/正文/标签关键词命中" : "部分关键词命中"
    });
  }

  const similarity = levenshteinSimilarity(query, name);
  best = takeBest(best, similarity > 0 ? { score: Math.round(similarity * 100), reason: "名称模糊匹配" } : undefined);
  return best;
}

function splitSearchTerms(query: string): string[] {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\s,，.。;；:：!?！？()[\]{}（）【】《》"'`~、/\\|]+/u)
    .map(normalizeSearchText)
    .filter((term) => term.length > 0);
}

function allTermsIn(terms: string[], text: string): boolean {
  return terms.every((term) => text.includes(term));
}

function takeBest(
  current: { score: number; reason: string } | undefined,
  candidate: { score: number; reason: string } | undefined
): { score: number; reason: string } | undefined {
  if (!candidate) {
    return current;
  }
  if (!current || candidate.score > current.score) {
    return candidate;
  }
  return current;
}

function levenshteinSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const distance = levenshteinDistance([...a], [...b]);
  return 1 - distance / Math.max([...a].length, [...b].length);
}

function levenshteinDistance(a: string[], b: string[]): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j]!;
    }
  }

  return previous[b.length]!;
}

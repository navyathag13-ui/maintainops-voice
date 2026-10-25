// Name matching for spoken references like "generator two" or "the drive belts".
// Deliberately simple and deterministic: the LLM never picks an id on its own,
// it has to go through this, and anything not unique comes back as ambiguous.

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  first: "1", second: "2", third: "3",
};

const FILLER = new Set(["the", "a", "an", "number", "no", "num", "unit", "my", "our"]);

function singular(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/#\s*0*(\d+)/g, " $1 ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => NUMBER_WORDS[t] ?? t)
    .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t))
    .filter((t) => !FILLER.has(t))
    .map(singular);
}

export type MatchResult<T> =
  | { kind: "resolved"; item: T }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "none"; suggestions: T[] };

function containsSequence(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, j) => haystack[i + j] === t)) return true;
  }
  return false;
}

// `context` is what the technician actually said. When the model's query is
// ambiguous ("cordless drill") but the technician said a full name in a row
// ("cordless drill two wouldn't hold a charge"), that wins. The words must be
// contiguous: "one air filter on the generator" must not resolve to Generator #01.
export function matchByName<T extends { name: string }>(query: string, items: T[], context: string[] = []): MatchResult<T> {
  const q = tokens(query);
  if (q.length === 0) return { kind: "none", suggestions: [] };
  const qKey = q.join(" ");

  const exact = items.filter((i) => tokens(i.name).join(" ") === qKey);
  if (exact.length === 1) return { kind: "resolved", item: exact[0] };

  const candidates = items.filter((i) => {
    const t = new Set(tokens(i.name));
    return q.every((tok) => t.has(tok));
  });
  if (candidates.length === 1) return { kind: "resolved", item: candidates[0] };
  if (candidates.length > 1) {
    const spoken = context.map(tokens);
    const named = candidates.filter((c) => spoken.some((u) => containsSequence(u, tokens(c.name))));
    if (named.length === 1) return { kind: "resolved", item: named[0] };
    return { kind: "ambiguous", candidates };
  }

  // Nothing contains every spoken word. Offer close names ("did you mean"),
  // but never resolve to one of them automatically.
  const scored = items
    .map((i) => {
      const t = new Set(tokens(i.name));
      const hits = q.filter((tok) => t.has(tok) && !/^\d+$/.test(tok)).length;
      return { i, score: hits / q.length };
    })
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => s.i);
  return { kind: "none", suggestions: scored };
}

// fuzzyScore performs a case-insensitive fuzzy match and returns a relevance
// score where lower is better:
//   - a contiguous substring match scores its start index (0 = prefix match);
//   - an in-order subsequence match scores above 1000, penalised by its span;
//   - no match (or a subsequence spread too far apart) returns Infinity.
// Subsequences must be dense: the matched characters may span less than 2x the
// query length. That keeps the filter useful — "test" matches "test_01" but
// not "ods_illegal_tyqresult" or "activeInfoResult", which only contain
// t-e-s-t scattered far apart.
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (q === '') return 0
  const t = text.toLowerCase()
  const sub = t.indexOf(q)
  if (sub >= 0) return sub
  let qi = 0
  let first = -1
  let last = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (first === -1) first = ti
      last = ti
      qi++
    }
  }
  if (qi !== q.length) return Infinity
  if (last - first >= q.length * 2) return Infinity
  return 1000 + (last - first)
}

// fuzzyMatch is the boolean form of fuzzyScore for callers that only need a
// filter. An empty/blank query matches anything.
export function fuzzyMatch(query: string, text: string): boolean {
  return fuzzyScore(query, text) !== Infinity
}

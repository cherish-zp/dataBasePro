// fuzzyMatch performs a case-insensitive subsequence match: every character of
// the query must appear in the text, in order. This gives a lightweight "fuzzy"
// filter (e.g. "usr" matches "user-log"). An empty/blank query matches anything.
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const t = text.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

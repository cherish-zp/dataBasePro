import { defineStore } from 'pinia'
import { ref } from 'vue'

// localStorage key for the SQL console history + saved queries. Bump the
// version suffix when the persisted shape changes.
export const SQL_HISTORY_STORAGE_KEY = 'dbclient.sql-history.v1'

const HISTORY_LIMIT = 20

export interface SavedQuery {
  name: string
  sql: string
}

// loadState reads the persisted {history, favorites} payload. Absent, corrupt
// or structurally invalid data degrades to an empty state — never throws.
function loadState(): { history: string[]; favorites: SavedQuery[] } {
  try {
    const raw = localStorage.getItem(SQL_HISTORY_STORAGE_KEY)
    if (!raw) return { history: [], favorites: [] }
    const parsed = JSON.parse(raw) as { history?: unknown; favorites?: unknown }
    const history = Array.isArray(parsed.history)
      ? parsed.history.filter((s): s is string => typeof s === 'string')
      : []
    const favorites = Array.isArray(parsed.favorites)
      ? parsed.favorites.filter(
          (f): f is SavedQuery =>
            typeof f === 'object' && f !== null &&
            typeof (f as SavedQuery).name === 'string' && typeof (f as SavedQuery).sql === 'string',
        )
      : []
    return { history, favorites }
  } catch {
    return { history: [], favorites: [] }
  }
}

export const useSqlHistoryStore = defineStore('sqlhistory', () => {
  const initial = loadState()
  const history = ref<string[]>(initial.history)
  const favorites = ref<SavedQuery[]>(initial.favorites)

  // persist writes through on every mutation so a restart restores the state.
  function persist(): void {
    try {
      localStorage.setItem(
        SQL_HISTORY_STORAGE_KEY,
        JSON.stringify({ history: history.value, favorites: favorites.value }),
      )
    } catch {
      // Quota / privacy-mode write failures must not break the console.
    }
  }

  // record logs a submitted query: trimmed, most-recent-first, deduped by
  // exact string (the existing entry moves to the front), capped at 20.
  function record(sql: string): void {
    const q = sql.trim()
    if (!q) return
    const idx = history.value.indexOf(q)
    if (idx >= 0) history.value.splice(idx, 1)
    history.value.unshift(q)
    if (history.value.length > HISTORY_LIMIT) history.value.length = HISTORY_LIMIT
    persist()
  }

  // saveFavorite upserts a named favorite: the same name replaces its SQL.
  function saveFavorite(name: string, sql: string): void {
    const n = name.trim()
    if (!n) return
    const existing = favorites.value.find((f) => f.name === n)
    if (existing) {
      existing.sql = sql.trim()
    } else {
      favorites.value.unshift({ name: n, sql: sql.trim() })
    }
    persist()
  }

  function removeFavorite(name: string): void {
    const idx = favorites.value.findIndex((f) => f.name === name)
    if (idx < 0) return
    favorites.value.splice(idx, 1)
    persist()
  }

  return { history, favorites, record, saveFavorite, removeFavorite }
})

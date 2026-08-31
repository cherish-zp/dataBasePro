import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SQL_HISTORY_STORAGE_KEY, useSqlHistoryStore } from './sqlhistory'

describe('sqlhistory store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('starts empty when nothing is persisted', () => {
    const store = useSqlHistoryStore()
    expect(store.history).toEqual([])
    expect(store.favorites).toEqual([])
  })

  it('record keeps the most recent query first and trims whitespace', () => {
    const store = useSqlHistoryStore()
    store.record('SELECT 1')
    store.record('  SELECT 2  ')
    expect(store.history).toEqual(['SELECT 2', 'SELECT 1'])
  })

  it('record ignores empty and whitespace-only queries', () => {
    const store = useSqlHistoryStore()
    store.record('')
    store.record('   ')
    expect(store.history).toEqual([])
  })

  it('record dedupes by exact string, moving the existing entry to the front', () => {
    const store = useSqlHistoryStore()
    store.record('SELECT 1')
    store.record('SELECT 2')
    store.record('SELECT 1')
    expect(store.history).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('record caps history at 20 entries', () => {
    const store = useSqlHistoryStore()
    for (let i = 0; i < 25; i++) store.record(`SELECT ${i}`)
    expect(store.history).toHaveLength(20)
    expect(store.history[0]).toBe('SELECT 24')
    expect(store.history[19]).toBe('SELECT 5')
  })

  it('saveFavorite upserts by name', () => {
    const store = useSqlHistoryStore()
    store.saveFavorite('errors', 'SELECT * FROM errors')
    store.saveFavorite('slow', 'SELECT * FROM slow')
    store.saveFavorite('errors', 'SELECT * FROM errors LIMIT 10')
    expect(store.favorites).toEqual([
      { name: 'slow', sql: 'SELECT * FROM slow' },
      { name: 'errors', sql: 'SELECT * FROM errors LIMIT 10' },
    ])
  })

  it('saveFavorite trims the name and ignores empty names', () => {
    const store = useSqlHistoryStore()
    store.saveFavorite('  ', 'SELECT 1')
    store.saveFavorite('  fav  ', 'SELECT 1')
    expect(store.favorites).toEqual([{ name: 'fav', sql: 'SELECT 1' }])
  })

  it('saveFavorite rejects blank SQL after trimming', () => {
    const store = useSqlHistoryStore()
    store.saveFavorite('empty', '')
    store.saveFavorite('spaces', '   ')
    store.saveFavorite('newlines', '\n\t  \n')
    expect(store.favorites).toEqual([])
  })

  it('saveFavorite does not overwrite an existing favorite with blank SQL', () => {
    const store = useSqlHistoryStore()
    store.saveFavorite('fav', 'SELECT 1')
    store.saveFavorite('fav', '   ')
    expect(store.favorites).toEqual([{ name: 'fav', sql: 'SELECT 1' }])
  })

  it('removeFavorite removes by name and ignores unknown names', () => {
    const store = useSqlHistoryStore()
    store.saveFavorite('a', 'SELECT 1')
    store.saveFavorite('b', 'SELECT 2')
    store.removeFavorite('missing')
    expect(store.favorites).toHaveLength(2)
    store.removeFavorite('a')
    expect(store.favorites).toEqual([{ name: 'b', sql: 'SELECT 2' }])
  })

  it('persists every mutation to localStorage', () => {
    const store = useSqlHistoryStore()
    store.record('SELECT 1')
    store.saveFavorite('fav', 'SELECT 2')
    const raw = localStorage.getItem(SQL_HISTORY_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual({
      history: ['SELECT 1'],
      favorites: [{ name: 'fav', sql: 'SELECT 2' }],
    })
  })

  it('restores state for a fresh store (app restart)', () => {
    const first = useSqlHistoryStore()
    first.record('SELECT 1')
    first.record('SELECT 2')
    first.saveFavorite('fav', 'SELECT 3')
    // Simulate an app restart: brand-new pinia, brand-new store instance.
    setActivePinia(createPinia())
    const second = useSqlHistoryStore()
    expect(second.history).toEqual(['SELECT 2', 'SELECT 1'])
    expect(second.favorites).toEqual([{ name: 'fav', sql: 'SELECT 3' }])
  })

  it('removeFavorite persists the removal across a reload from storage', () => {
    const first = useSqlHistoryStore()
    first.saveFavorite('a', 'SELECT 1')
    first.saveFavorite('b', 'SELECT 2')
    first.removeFavorite('a')
    // Simulate an app restart: a fresh store rebuilt from localStorage must no
    // longer contain the removed favorite, and the persisted payload is synced.
    setActivePinia(createPinia())
    const second = useSqlHistoryStore()
    expect(second.favorites).toEqual([{ name: 'b', sql: 'SELECT 2' }])
    expect(JSON.parse(localStorage.getItem(SQL_HISTORY_STORAGE_KEY) as string)).toEqual({
      history: [],
      favorites: [{ name: 'b', sql: 'SELECT 2' }],
    })
  })

  it('degrades to an empty state on corrupt storage without throwing', () => {
    localStorage.setItem(SQL_HISTORY_STORAGE_KEY, 'not-json')
    const store = useSqlHistoryStore()
    expect(store.history).toEqual([])
    expect(store.favorites).toEqual([])
  })

  it('degrades to an empty state on structurally invalid payloads', () => {
    localStorage.setItem(SQL_HISTORY_STORAGE_KEY, JSON.stringify({ history: 'nope', favorites: 42 }))
    const store = useSqlHistoryStore()
    expect(store.history).toEqual([])
    expect(store.favorites).toEqual([])
  })
})

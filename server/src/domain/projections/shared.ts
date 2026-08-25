/**
 * PostgreSQL cannot upsert the same key twice in one statement. Collapsing
 * duplicate snapshot rows here prevents a malformed payload from permanently
 * failing every synchronization retry.
 */
export function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

export const KEY_SEPARATOR = String.fromCharCode(31);

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbFile = path.join(process.cwd(), ".e2e-runtime/data/at-ai-workforce.db");

export function query<T>(sql: string, ...params: Array<string | number | null>): T[] {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    // The Next server writes to the same SQLite file. Wait for its short
    // transactions instead of failing the assertion with "database is locked".
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export function one<T>(sql: string, ...params: Array<string | number | null>): T | null {
  return query<T>(sql, ...params)[0] ?? null;
}

export function execute(sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

export async function waitForDb<T>(
  read: () => T | null | undefined | false,
  options: { timeout?: number; interval?: number; message?: string } = {},
): Promise<T> {
  const timeout = options.timeout ?? 15_000;
  const interval = options.interval ?? 150;
  const deadline = Date.now() + timeout;
  let last: T | null | undefined | false;
  while (Date.now() < deadline) {
    last = read();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(options.message ?? `Database condition was not met within ${timeout}ms (last=${JSON.stringify(last)})`);
}

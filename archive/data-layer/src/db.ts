import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  return new pg.Pool({ connectionString });
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("begin");
    const result = await fn(tx);
    await tx.query("commit");
    return result;
  } catch (err) {
    await tx.query("rollback");
    throw err;
  } finally {
    tx.release();
  }
}

export type ErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid"
  | "session_full"
  | "name_taken"
  | "wrong_status";

export class DomainError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

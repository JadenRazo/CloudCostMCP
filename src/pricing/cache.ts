import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger.js";
import type { CacheEntry, CacheStats } from "./types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pricing_cache (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    provider   TEXT NOT NULL,
    service    TEXT NOT NULL,
    region     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pricing_cache_provider   ON pricing_cache (provider);
  CREATE INDEX IF NOT EXISTS idx_pricing_cache_expires_at ON pricing_cache (expires_at);
`;

export class PricingCache {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);

    // WAL mode allows concurrent readers alongside a single writer, which is
    // the dominant access pattern for a pricing cache.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(SCHEMA);

    logger.debug("PricingCache initialised", { dbPath });
  }

  /**
   * Retrieve a cached value by key. Returns null when the entry does not exist
   * or has already expired; expired rows are deleted as a side-effect so the
   * table self-trims on read.
   */
  get<T>(key: string): T | null {
    try {
      const row = this.db
        .prepare<[string], CacheEntry>(
          "SELECT * FROM pricing_cache WHERE key = ?"
        )
        .get(key);

      if (!row) return null;

      const now = new Date().toISOString();
      if (row.expires_at <= now) {
        this.db
          .prepare("DELETE FROM pricing_cache WHERE key = ?")
          .run(key);
        logger.debug("Cache miss (expired)", { key });
        return null;
      }

      logger.debug("Cache hit", { key });
      return JSON.parse(row.data) as T;
    } catch (err) {
      logger.warn("Cache get failed, treating as miss", {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Store a value in the cache.
   *
   * The composite key convention for pricing lookups is:
   *   `{provider}/{service}/{region}/{resource_type}`
   *
   * Callers are responsible for constructing the key before calling this
   * method; the method itself treats the key as an opaque string so it can
   * be reused for other cache domains in the future.
   */
  set<T>(
    key: string,
    data: T,
    provider: string,
    service: string,
    region: string,
    ttlSeconds: number
  ): void {
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      this.db
        .prepare(
          `INSERT INTO pricing_cache (key, data, provider, service, region, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           data       = excluded.data,
           provider   = excluded.provider,
           service    = excluded.service,
           region     = excluded.region,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`
        )
        .run(
          key,
          JSON.stringify(data),
          provider,
          service,
          region,
          now.toISOString(),
          expiresAt.toISOString()
        );

      logger.debug("Cache set", { key, ttlSeconds });
    } catch (err) {
      logger.warn("Cache set failed, continuing without caching", {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Remove a single cache entry. */
  invalidate(key: string): void {
    try {
      const result = this.db
        .prepare("DELETE FROM pricing_cache WHERE key = ?")
        .run(key);
      logger.debug("Cache invalidated", { key, removed: result.changes });
    } catch (err) {
      logger.warn("Cache invalidate failed", {
        key,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Remove every cache entry belonging to a provider. */
  invalidateByProvider(provider: string): void {
    try {
      const result = this.db
        .prepare("DELETE FROM pricing_cache WHERE provider = ?")
        .run(provider);
      logger.debug("Cache invalidated by provider", {
        provider,
        removed: result.changes,
      });
    } catch (err) {
      logger.warn("Cache invalidateByProvider failed", {
        provider,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Delete all entries whose expiry timestamp is in the past.
   * Returns the number of rows removed.
   */
  cleanup(): number {
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare("DELETE FROM pricing_cache WHERE expires_at <= ?")
        .run(now);
      const removed = result.changes;
      logger.debug("Cache cleanup complete", { removed });
      return removed;
    } catch (err) {
      logger.warn("Cache cleanup failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /** Return aggregate statistics about the current cache state. */
  getStats(): CacheStats {
    try {
      const now = new Date().toISOString();

      const totals = this.db
        .prepare<[], { total_entries: number; size_bytes: number }>(
          `SELECT
           COUNT(*)                        AS total_entries,
           COALESCE(SUM(LENGTH(data)), 0)  AS size_bytes
         FROM pricing_cache`
        )
        .get()!;

      const expired = this.db
        .prepare<[string], { expired_entries: number }>(
          "SELECT COUNT(*) AS expired_entries FROM pricing_cache WHERE expires_at <= ?"
        )
        .get(now)!;

      return {
        total_entries: totals.total_entries,
        expired_entries: expired.expired_entries,
        size_bytes: totals.size_bytes,
      };
    } catch (err) {
      logger.warn("Cache getStats failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { total_entries: 0, expired_entries: 0, size_bytes: 0 };
    }
  }

  /**
   * Begin a batch write transaction. All subsequent `.set()` calls will be
   * grouped into a single SQLite transaction until `endBatch()` is called.
   * This can yield ~100x throughput improvement over individual transactions
   * when caching large numbers of pricing rows (e.g. AWS EC2 CSV bulk load).
   *
   * Must be paired with a corresponding `endBatch()` or `rollbackBatch()`.
   * Do not nest batch calls.
   */
  beginBatch(): void {
    try {
      this.db.exec("BEGIN TRANSACTION");
      logger.debug("PricingCache batch started");
    } catch (err) {
      logger.warn("PricingCache beginBatch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Commit all `.set()` calls made since the last `beginBatch()`.
   */
  endBatch(): void {
    try {
      this.db.exec("COMMIT");
      logger.debug("PricingCache batch committed");
    } catch (err) {
      logger.warn("PricingCache endBatch failed, attempting rollback", {
        err: err instanceof Error ? err.message : String(err),
      });
      this.rollbackBatch();
    }
  }

  /**
   * Roll back a batch transaction, discarding all `.set()` calls made since
   * `beginBatch()`. Called automatically by `endBatch()` on commit failure.
   */
  rollbackBatch(): void {
    try {
      this.db.exec("ROLLBACK");
      logger.debug("PricingCache batch rolled back");
    } catch (err) {
      logger.warn("PricingCache rollbackBatch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
    logger.debug("PricingCache closed");
  }
}

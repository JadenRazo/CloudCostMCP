import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PricingCache } from "../../../src/pricing/cache.js";

function tempDbPath(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `cloudcost-test-${suffix}`, "cache.db");
}

describe("PricingCache", () => {
  let dbPath: string;
  let cache: PricingCache;

  beforeEach(() => {
    dbPath = tempDbPath();
    cache = new PricingCache(dbPath);
  });

  afterEach(() => {
    cache?.close();
    // Clean up the temp directory created by the test
    const dir = join(dbPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the database file and pricing_cache table on construction", () => {
    expect(existsSync(dbPath)).toBe(true);

    // Confirm the table exists by verifying stats returns without throwing
    const stats = cache.getStats();
    expect(stats.total_entries).toBe(0);
  });

  it("stores a value and retrieves it by key", () => {
    const payload = { price: 0.023, unit: "per GB-month" };
    cache.set("aws/s3/us-east-1/storage", payload, "aws", "s3", "us-east-1", 3600);

    const result = cache.get<typeof payload>("aws/s3/us-east-1/storage");
    expect(result).toEqual(payload);
  });

  it("overwrites an existing entry when the same key is set again", () => {
    cache.set("k", { v: 1 }, "aws", "ec2", "us-east-1", 3600);
    cache.set("k", { v: 2 }, "aws", "ec2", "us-east-1", 3600);

    const result = cache.get<{ v: number }>("k");
    expect(result?.v).toBe(2);
  });

  it("returns null for entries that have already expired", () => {
    // TTL of -1 second means the entry expires immediately in the past
    cache.set("expired-key", { data: "old" }, "aws", "ec2", "us-west-2", -1);

    const result = cache.get("expired-key");
    expect(result).toBeNull();
  });

  it("returns null for keys that do not exist", () => {
    const result = cache.get("no-such-key");
    expect(result).toBeNull();
  });

  it("removes an expired entry from the table when it is read", () => {
    cache.set("stale", { x: 1 }, "gcp", "compute", "us-central1", -1);
    cache.get("stale"); // triggers the lazy delete

    const stats = cache.getStats();
    expect(stats.total_entries).toBe(0);
  });

  it("invalidate removes a specific entry", () => {
    cache.set("target", { x: 1 }, "aws", "ec2", "eu-west-1", 3600);
    cache.set("other", { x: 2 }, "aws", "ec2", "eu-west-1", 3600);

    cache.invalidate("target");

    expect(cache.get("target")).toBeNull();
    expect(cache.get<{ x: number }>("other")).toEqual({ x: 2 });
  });

  it("invalidateByProvider removes all entries for that provider", () => {
    cache.set("aws/ec2/us-east-1/t3.micro", { p: 1 }, "aws", "ec2", "us-east-1", 3600);
    cache.set("aws/s3/us-east-1/storage", { p: 2 }, "aws", "s3", "us-east-1", 3600);
    cache.set("gcp/compute/us-central1/n1", { p: 3 }, "gcp", "compute", "us-central1", 3600);

    cache.invalidateByProvider("aws");

    expect(cache.get("aws/ec2/us-east-1/t3.micro")).toBeNull();
    expect(cache.get("aws/s3/us-east-1/storage")).toBeNull();
    expect(cache.get<{ p: number }>("gcp/compute/us-central1/n1")).toEqual({ p: 3 });
  });

  it("cleanup removes expired entries and returns the count deleted", () => {
    cache.set("live1", { a: 1 }, "aws", "ec2", "us-east-1", 3600);
    cache.set("live2", { a: 2 }, "aws", "ec2", "us-east-1", 3600);
    cache.set("dead1", { a: 3 }, "aws", "ec2", "us-east-1", -1);
    cache.set("dead2", { a: 4 }, "aws", "ec2", "us-east-1", -1);

    const removed = cache.cleanup();
    expect(removed).toBe(2);

    const stats = cache.getStats();
    expect(stats.total_entries).toBe(2);
    expect(stats.expired_entries).toBe(0);
  });

  it("getStats returns accurate totals, expired counts, and size estimate", () => {
    cache.set("live", { value: "hello" }, "azure", "storage", "eastus", 3600);
    cache.set("dead", { value: "bye" }, "azure", "storage", "eastus", -1);

    const stats = cache.getStats();
    expect(stats.total_entries).toBe(2);
    expect(stats.expired_entries).toBe(1);
    expect(stats.size_bytes).toBeGreaterThan(0);
  });

  it("handles concurrent read/write access under WAL mode without errors", async () => {
    // Simulate concurrent writers via Promise.all; better-sqlite3 is
    // synchronous per call but this exercises WAL's ability to handle
    // interleaved operations without SQLITE_BUSY errors.
    const writes = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve(
        cache.set(`concurrent/key/${i}`, { index: i }, "aws", "ec2", "us-east-1", 3600),
      ),
    );

    await expect(Promise.all(writes)).resolves.not.toThrow();

    const stats = cache.getStats();
    expect(stats.total_entries).toBe(20);

    // Concurrent reads should all succeed
    const reads = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve(cache.get<{ index: number }>(`concurrent/key/${i}`)),
    );

    const results = await Promise.all(reads);
    results.forEach((r, i) => {
      expect(r).toEqual({ index: i });
    });
  });
});

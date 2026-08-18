import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/httpError.js';

/**
 * A deliberately small token bucket on the send path only.
 *
 * This is not a general rate limiter and does not pretend to be one — it is
 * in-memory, so it resets on restart and does not coordinate across replicas.
 * It exists for one reason: a single looping client would both fill the
 * messages table and fan a broadcast out to every live connection, against a
 * Realtime ceiling of 100 messages/second on the free plan. One buggy tab
 * should not be able to take chat down for the office.
 *
 * Replace with a shared limiter if this ever runs on more than one process.
 */

const CAPACITY = 20; // burst
const REFILL_PER_SECOND = 2; // sustained
const IDLE_EVICT_MS = 10 * 60 * 1000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

function take(key: string, now: number): boolean {
  const bucket = buckets.get(key) ?? { tokens: CAPACITY, updatedAt: now };

  const elapsedSeconds = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsedSeconds * REFILL_PER_SECOND);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

/// Keeps the map from growing with every account that ever sent a message.
function evictIdle(now: number): void {
  if (buckets.size < 500) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > IDLE_EVICT_MS) buckets.delete(key);
  }
}

export function limitSendRate(req: Request, _res: Response, next: NextFunction): void {
  const userId = req.user?.id;
  if (!userId) return next();

  const now = Date.now();
  evictIdle(now);

  if (!take(userId, now)) {
    // AppError has no 429 factory — this is the only place in the codebase
    // that needs one, so it is constructed directly rather than widening the
    // shared helper for a single caller.
    throw new AppError(429, 'TOO_MANY_REQUESTS', 'You are sending messages too quickly');
  }

  return next();
}

/// Test seam — the suite sends far more than 20 messages in a run.
export function resetSendRateLimits(): void {
  buckets.clear();
}

/**
 * @title Caller limits
 * @notice In-process caps on how many tool calls one gateway replica will do.
 * @dev Both structures live in this process. A second replica has its own
 *      copies, so the effective public cap is these numbers times the replica
 *      count. There is no Redis in this version. The first hosted deploy
 *      stays at one replica for that reason.
 *
 *      The token bucket is per TCP peer address. X-Forwarded-For is ignored
 *      so a client cannot mint a fresh bucket by writing a header. Behind a
 *      future ingress, the peer will be the ingress pod until we teach the
 *      gateway to trust that hop. Local port-forward has the same shape:
 *      every local client shares the forwarder's address.
 */

import type { LimitConfig } from "./types.js";

/**
 * @notice One client's tokens.
 * @param tokens Whole and fractional tokens remaining. Fractional tokens
 *        accumulate between calls so a 30/minute refill is exact.
 * @param updatedAt Milliseconds timestamp of the last refill calculation.
 */
interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * @notice How long an idle address keeps a bucket.
 * @dev Without this, a public gateway would store one object per source
 *      address forever. Ten minutes of silence drops the entry. The next
 *      call from that address starts with a full burst again, which matches
 *      "burst is for a fresh arrival".
 */
const IDLE_MS = 10 * 60 * 1000;

/**
 * @notice Token bucket shared by every address this process has seen recently.
 * @dev Capacity is `burst`. Refill is `perMinute` spread across the minute.
 *      `tryTake` costs one token. `refund` gives one back, capped at capacity,
 *      for the case where we counted a call we then refused for concurrency.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  /**
   * @param limits Rate fields from config. `maxInFlight` is not used here.
   * @param now Clock, replaced in tests so they do not sleep.
   */
  constructor(
    limits: Pick<LimitConfig, "perMinute" | "burst">,
    now: () => number = Date.now,
  ) {
    this.capacity = limits.burst;
    this.refillPerMs = limits.perMinute / 60_000;
    this.now = now;
  }

  /**
   * @notice Spend one token for this address.
   * @param key Client address, already normalized.
   * @returns True when the call may proceed.
   */
  tryTake(key: string): boolean {
    this.prune();
    const bucket = this.refill(key);
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /**
   * @notice Return one token, never above the burst size.
   * @param key Address whose last tryTake should be undone.
   */
  refund(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return;
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + 1);
  }

  /**
   * @notice Apply refill since the last visit, creating a full bucket if needed.
   * @param key Client address.
   * @returns The stored bucket. The caller mutates `tokens`.
   */
  private refill(key: string): Bucket {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (!existing) {
      const created = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, created);
      return created;
    }
    const elapsed = Math.max(0, now - existing.updatedAt);
    existing.tokens = Math.min(
      this.capacity,
      existing.tokens + elapsed * this.refillPerMs,
    );
    existing.updatedAt = now;
    return existing;
  }

  /**
   * @notice Drop addresses that have been quiet longer than IDLE_MS.
   * @dev Scanning the map on every call is cheap at the sizes this process
   *      will see. The idle window is the bound on memory.
   */
  private prune(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > IDLE_MS) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * @notice Count of tools/call handlers currently inside this process.
 * @dev tryEnter and leave must pair. HTTP code releases on both finish and
 *      close because a client can hang up before the backend answers.
 *      leave() below zero is ignored so a double release is safe.
 */
export class InFlightGate {
  private current = 0;

  /**
   * @param max Highest value `current` may reach. From `limits.maxInFlight`.
   */
  constructor(private readonly max: number) {}

  /**
   * @notice Reserve one slot.
   * @returns False when this process is already at the cap.
   */
  tryEnter(): boolean {
    if (this.current >= this.max) {
      return false;
    }
    this.current += 1;
    return true;
  }

  /**
   * @notice Release one slot reserved by tryEnter.
   */
  leave(): void {
    if (this.current > 0) {
      this.current -= 1;
    }
  }
}

/**
 * @notice TCP peer address used as the rate-limit key.
 * @param remoteAddress `socket.remoteAddress`. Undefined becomes `"unknown"`,
 *        and those callers share one bucket rather than skipping the limit.
 * @returns Address without the IPv4-mapped IPv6 prefix.
 * @dev `::ffff:127.0.0.1` and `127.0.0.1` are the same peer. Counting them
 *      separately would double the burst for one laptop.
 */
export function clientAddress(remoteAddress: string | undefined): string {
  if (!remoteAddress) {
    return "unknown";
  }
  if (remoteAddress.startsWith("::ffff:")) {
    return remoteAddress.slice("::ffff:".length);
  }
  return remoteAddress;
}

/**
 * @title Limit tests
 * @notice The numbers in gateway.yaml are only meaningful if this bucket
 *         matches the comment there: burst immediately, then refill per minute.
 *         The clock is injected so the test does not sleep for a minute.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { clientAddress, InFlightGate, TokenBucket } from "./limits.js";

test("burst is spendable immediately and then the bucket is empty", () => {
  let now = 1_000;
  const bucket = new TokenBucket({ perMinute: 30, burst: 10 }, () => now);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(bucket.tryTake("127.0.0.1"), true);
  }
  assert.equal(bucket.tryTake("127.0.0.1"), false);
});

test("thirty per minute refills one token every two seconds", () => {
  let now = 0;
  const bucket = new TokenBucket({ perMinute: 30, burst: 10 }, () => now);
  for (let i = 0; i < 10; i += 1) {
    bucket.tryTake("10.0.0.1");
  }
  now += 1_999;
  assert.equal(bucket.tryTake("10.0.0.1"), false);
  now += 1;
  assert.equal(bucket.tryTake("10.0.0.1"), true);
  assert.equal(bucket.tryTake("10.0.0.1"), false);
});

test("addresses do not share a bucket, and a refund cannot exceed the burst", () => {
  const bucket = new TokenBucket({ perMinute: 30, burst: 2 });
  assert.equal(bucket.tryTake("a"), true);
  assert.equal(bucket.tryTake("b"), true);
  bucket.refund("a");
  bucket.refund("a");
  bucket.refund("a");
  // Three refunds still leave only the burst of two.
  assert.equal(bucket.tryTake("a"), true);
  assert.equal(bucket.tryTake("a"), true);
  assert.equal(bucket.tryTake("a"), false);
  // b spent one token of its own and was not refunded.
  assert.equal(bucket.tryTake("b"), true);
  assert.equal(bucket.tryTake("b"), false);
});

test("the in-flight gate rejects the call that would exceed the cap", () => {
  const gate = new InFlightGate(1);
  assert.equal(gate.tryEnter(), true);
  assert.equal(gate.tryEnter(), false);
  gate.leave();
  gate.leave();
  assert.equal(gate.tryEnter(), true);
});

test("IPv4-mapped IPv6 addresses share a bucket with the IPv4 form", () => {
  assert.equal(clientAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(clientAddress(undefined), "unknown");
});

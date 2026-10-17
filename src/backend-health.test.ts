/**
 * @title Backend circuit tests
 * @notice The gateway stays up when one backend is down. These tests are
 *         the rules that make that safe: an unknown backend is still called,
 *         two transport failures stop the calls, a tool error does not, and
 *         one trial is allowed only after the cooldown.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BackendHealth, TRIAL_AFTER_MS } from "./backend-health.js";

test("an unknown backend is not rejected", () => {
  const health = new BackendHealth();
  assert.equal(health.rejectCall("medical"), false);
});

test("two transport failures open the circuit and a success closes it", () => {
  const health = new BackendHealth();
  health.recordTransportFailure("bitcoin");
  assert.equal(health.rejectCall("bitcoin"), false);
  health.recordTransportFailure("bitcoin");
  assert.equal(health.rejectCall("bitcoin"), true);
  health.recordSuccess("bitcoin");
  assert.equal(health.rejectCall("bitcoin"), false);
});

test("a tool error does not open the circuit or reset the streak", () => {
  const health = new BackendHealth();
  health.recordTransportFailure("medical");
  health.recordApplicationFailure("medical");
  assert.equal(health.rejectCall("medical"), false);
  health.recordTransportFailure("medical");
  assert.equal(health.rejectCall("medical"), true);
});

test("two failed probes open the circuit and a successful probe closes it", () => {
  const health = new BackendHealth();
  assert.equal(health.recordProbe("medical", false), true);
  assert.equal(health.rejectCall("medical"), false);
  assert.equal(health.recordProbe("medical", false), false);
  assert.equal(health.rejectCall("medical"), true);
  assert.equal(health.recordProbe("medical", true), true);
  assert.equal(health.rejectCall("medical"), false);
});

test("a trial is allowed only after the cooldown, and a failure restarts it", () => {
  let now = 1_000;
  const health = new BackendHealth(() => now);
  health.recordTransportFailure("bitcoin");
  health.recordTransportFailure("bitcoin");
  assert.equal(health.rejectCall("bitcoin"), true);

  now += TRIAL_AFTER_MS - 1;
  assert.equal(health.rejectCall("bitcoin"), true);

  now += 1;
  assert.equal(health.rejectCall("bitcoin"), false);
  assert.equal(health.rejectCall("bitcoin"), true);

  health.recordTransportFailure("bitcoin");
  assert.equal(health.rejectCall("bitcoin"), true);

  now += TRIAL_AFTER_MS;
  assert.equal(health.rejectCall("bitcoin"), false);
});

/**
 * @title Name tests
 * @notice The prefix is the whole routing scheme. If these fail, a client
 *         name will not map back to the backend tool we meant.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isLegalPublicName,
  parsePublicToolName,
  publicToolName,
} from "./names.js";

test("public names join on a double underscore and parse back", () => {
  const name = publicToolName("medical", "list-sources");
  assert.equal(name, "medical__list-sources");
  assert.deepEqual(parsePublicToolName(name), {
    backendId: "medical",
    toolName: "list-sources",
  });
});

test("a single underscore inside the tool name is not the separator", () => {
  const parsed = parsePublicToolName("medical__search_drugs");
  assert.deepEqual(parsed, {
    backendId: "medical",
    toolName: "search_drugs",
  });
});

test("names without a separator do not route", () => {
  assert.equal(parsePublicToolName("health-check"), null);
  assert.equal(parsePublicToolName("__hidden"), null);
  assert.equal(parsePublicToolName("medical__"), null);
});

test("names longer than 64 characters are not published", () => {
  const name = publicToolName("medical", "x".repeat(60));
  assert.equal(name.length > 64, true);
  assert.equal(isLegalPublicName(name), false);
  assert.equal(isLegalPublicName("medical__list-sources"), true);
});

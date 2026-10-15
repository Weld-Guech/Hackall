import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldReacquireWakeLock } from "./wakeLockPolicy.ts";

test("redemande un verrou quand l'onglet redevient visible après une libération", () => {
  assert.equal(shouldReacquireWakeLock("visible", { released: true }), true);
  assert.equal(shouldReacquireWakeLock("visible", null), true);
});

test("ne redemande pas tant que le verrou est encore tenu", () => {
  assert.equal(shouldReacquireWakeLock("visible", { released: false }), false);
});

test("ne redemande pas tant que l'onglet est en arrière-plan", () => {
  assert.equal(shouldReacquireWakeLock("hidden", { released: true }), false);
  assert.equal(shouldReacquireWakeLock("hidden", null), false);
});

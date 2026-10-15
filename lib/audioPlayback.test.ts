import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PLAYBACK_GUARD_MS,
  UNKNOWN_DURATION_GUARD_MS,
  playbackGuardMs,
  resumeWithTimeout,
} from "./audioPlayback.ts";

test("plafonne une durée infinie au lieu de bloquer la file pendant des jours", () => {
  assert.equal(playbackGuardMs(Infinity), UNKNOWN_DURATION_GUARD_MS);
  assert.equal(playbackGuardMs(Number.NaN), UNKNOWN_DURATION_GUARD_MS);
  assert.equal(playbackGuardMs(-1), UNKNOWN_DURATION_GUARD_MS);
});

test("garde un délai raisonnable pour une annonce normale", () => {
  assert.equal(playbackGuardMs(2.5), 3500);
  assert.equal(playbackGuardMs(120), MAX_PLAYBACK_GUARD_MS);
});

test("resumeWithTimeout ne reste pas pendu si resume() ne se résout jamais", async () => {
  const hung = () => new Promise<void>(() => {});
  const t0 = Date.now();
  await resumeWithTimeout(hung, 40);
  assert.ok(Date.now() - t0 < 500);
});

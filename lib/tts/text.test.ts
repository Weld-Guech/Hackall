import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXED, TTS_PIPELINE_VERSION, canonicalName, resolveSegment, shortHash, urlFor } from "./text.ts";
import { buildIdsAnnouncement, buildLibreAnnouncement } from "./segments.ts";

test("un numéro est prononcé en lettres et normalisé (007 et 7 : même segment)", () => {
  const a = resolveSegment("007", "id");
  const b = resolveSegment("7", "id");
  assert.ok(a.ok && b.ok);
  assert.equal(a.input, "7");
  assert.equal(a.spoken, "sept");
  assert.equal(b.input, a.input);
  const big = resolveSegment("125", "id");
  assert.ok(big.ok);
  assert.equal(big.spoken, "cent vingt-cinq");
});

test("un prénom tapé de deux façons donne le même segment, correction appliquée", () => {
  const a = resolveSegment("  rAYANE ", "id");
  const b = resolveSegment("Rayane", "id");
  assert.ok(a.ok && b.ok);
  assert.equal(a.input, "Rayane");
  assert.equal(a.input, b.input);
  const ayoub = resolveSegment("ayoub", "id");
  assert.ok(ayoub.ok);
  assert.equal(ayoub.spoken, "Aïoub");
});

test("les marqueurs ** des corrections incertaines ne sont jamais prononcés", () => {
  const r = resolveSegment("wissam", "id");
  assert.ok(r.ok);
  assert.equal(r.spoken, "Wissam");
});

test("prénoms composés et apostrophes", () => {
  assert.equal(canonicalName("fatima-zahra"), "Fatima-Zahra");
  const m = resolveSegment("M’hamed", "id");
  assert.ok(m.ok);
  assert.equal(m.spoken, "Mhamed");
});

test("refuse les segments invalides (contexte, fixe inconnu, caractères)", () => {
  assert.equal(resolveSegment("La commande", "autre").ok, false);
  assert.equal(resolveSegment("Bonjour", "fixe").ok, false);
  assert.equal(resolveSegment("<script>", "id").ok, false);
  assert.equal(resolveSegment("x".repeat(501), "libre").ok, false);
});

test("le contexte d'intonation est fourni pour les segments fixes et les identifiants", () => {
  const id = resolveSegment("Rayane", "id");
  assert.ok(id.ok);
  assert.equal(id.previous, FIXED.LA_COMMANDE);
  assert.equal(id.next, FIXED.EST_PRETE);
  const libre = resolveSegment("Fermeture dans 10 minutes", "libre");
  assert.ok(libre.ok);
  assert.equal(libre.previous, undefined);
});

test("la version d'URL dépend du texte prononcé du segment, pas de toute la table", () => {
  const v = (url: string | null) => new URL(url ?? "", "http://x").searchParams.get("v");
  assert.equal(v(urlFor("7", "id", "t")), `${TTS_PIPELINE_VERSION}.${shortHash("sept")}.t`);
  assert.equal(v(urlFor("Ayoub", "id", "")), `${TTS_PIPELINE_VERSION}.${shortHash("Aïoub")}`);
  assert.equal(urlFor("<b>", "id", ""), null);
});

test("annonce simple : 3 segments et phrase complète pour Piper", () => {
  const a = buildIdsAnnouncement([{ raw: "rayane", label: "rayane" }], "t");
  assert.equal(a.parts.length, 3);
  assert.deepEqual(a.parts[1], { url: urlFor("rAyAnE", "id", "t") });
  assert.equal(a.text, "La commande Raïane est prête.");
  assert.equal(a.piperText, a.text);
});

test("annonce groupée : virgule en pause, 'et' avant le dernier", () => {
  const a = buildIdsAnnouncement(
    [
      { raw: "12", label: "N° 12" },
      { raw: "Ali", label: "Ali" },
      { raw: "3", label: "N° 3" },
    ],
    ""
  );
  assert.equal(a.text, "Les commandes douze, Ali et trois sont prêtes.");
  assert.deepEqual(
    a.parts.map((p) => ("pause" in p ? "pause" : new URL(p.url, "http://x").searchParams.get("seg"))),
    ["Les commandes", "12", "pause", "Ali", "et", "3", "sont prêtes."]
  );
  const two = buildIdsAnnouncement(
    [
      { raw: "1", label: "1" },
      { raw: "2", label: "2" },
    ],
    ""
  );
  assert.equal(two.text, "Les commandes un et deux sont prêtes.");
});

test("texte libre : un seul segment, pas de relecture Piper", () => {
  const a = buildLibreAnnouncement("  Fermeture   dans 10 minutes ", "Fermeture", "");
  assert.equal(a.parts.length, 1);
  assert.equal(a.piperText, null);
});

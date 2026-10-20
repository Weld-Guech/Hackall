// Logique de texte TTS partagée entre le kiosque (construction des URL de
// segments) et le serveur (texte réellement envoyé à ElevenLabs / Piper).
// Les deux côtés doivent produire exactement la même forme canonique d'un
// segment, sinon le même prénom aurait deux URL (et deux entrées de cache
// navigateur) différentes.
import { PHONETIC_MAP } from "../phoneticCorrections.ts";

export type TtsCtx = "fixe" | "id" | "libre";

// À incrémenter quand le rendu d'un segment change sans que son texte change
// (modèle ElevenLabs, voix par défaut, contexte d'intonation...) : force les
// tablettes à redemander les fichiers servis en "immutable". Le cache
// disque du serveur, lui, a sa propre clé (voir lib/tts/server.ts).
export const TTS_PIPELINE_VERSION = "1";

export const MAX_LIBRE_LENGTH = 500;
const MAX_NAME_LENGTH = 40;

// Segments fixes des annonces, préchargés au démarrage du service.
export const FIXED = {
  LA_COMMANDE: "La commande",
  EST_PRETE: "est prête.",
  LES_COMMANDES: "Les commandes",
  ET: "et",
  SONT_PRETES: "sont prêtes.",
} as const;

type SpeechContext = { previous?: string; next?: string };

// previous_text / next_text envoyés à ElevenLabs : la voix intone chaque
// segment comme s'il était au milieu de la phrase complète, ce qui évite
// l'effet "mots collés" au raccord.
const FIXED_CONTEXT: Record<string, SpeechContext> = {
  [FIXED.LA_COMMANDE]: { next: "trente-deux est prête." },
  [FIXED.EST_PRETE]: { previous: "La commande trente-deux" },
  [FIXED.LES_COMMANDES]: { next: "douze et quinze sont prêtes." },
  [FIXED.ET]: { previous: "Les commandes douze", next: "quinze sont prêtes." },
  [FIXED.SONT_PRETES]: { previous: "Les commandes douze et quinze" },
};
const ID_CONTEXT: SpeechContext = { previous: "La commande", next: "est prête." };

export type ResolvedSegment = {
  ctx: TtsCtx;
  kind: "fixe" | "numero" | "prenom" | "libre";
  // Forme canonique du segment, utilisée dans l'URL.
  input: string;
  // Texte réellement prononcé (nombre en lettres, correction phonétique).
  spoken: string;
  previous?: string;
  next?: string;
};

export type ResolveResult = ({ ok: true } & ResolvedSegment) | { ok: false; error: string };

// Hash FNV-1a 32 bits : court, synchrone et identique côté navigateur et
// Node (pas besoin de crypto.subtle, asynchrone et absent en HTTP).
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Convertit un nombre (0-999) en toutes lettres françaises, pour éviter
// que le TTS ne lise les chiffres un par un sur les nombres composés
// (125 lu "cent vingt-cinq" plutôt que "un deux cinq").
export function numberToFrenchWords(n: number): string {
  if (n === 0) return "zéro";

  const units = [
    "", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
    "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
    "dix-sept", "dix-huit", "dix-neuf",
  ];
  const tens = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"];

  function twoDigits(n: number): string {
    if (n < 20) return units[n];
    const t = Math.floor(n / 10);
    const u = n % 10;

    if (t === 7 || t === 9) {
      const base = t === 7 ? "soixante" : "quatre-vingt";
      if (u === 1 && t === 7) return `${base}-et-onze`;
      return `${base}-${units[10 + u]}`;
    }
    if (t === 8) {
      return u === 0 ? "quatre-vingts" : `quatre-vingt-${units[u]}`;
    }
    if (u === 0) return tens[t];
    if (u === 1) return `${tens[t]}-et-un`;
    return `${tens[t]}-${units[u]}`;
  }

  const h = Math.floor(n / 100);
  const rest = n % 100;

  if (h === 0) return twoDigits(rest);

  let str = h === 1 ? "cent" : `${units[h]} cent`;
  if (h > 1 && rest === 0) str += "s"; // "deux cents" mais "deux cent vingt"
  if (rest > 0) str += ` ${twoDigits(rest)}`;

  return str;
}

function collapseSpaces(s: string): string {
  return s.normalize("NFC").replace(/’/g, "'").replace(/\s+/g, " ").trim();
}

// "rAYANE" → "Rayane", "fatima-zahra" → "Fatima-Zahra" : la même personne
// tapée de deux façons partage un seul fichier audio.
export function canonicalName(raw: string): string {
  return collapseSpaces(raw)
    .toLocaleLowerCase("fr")
    .replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toLocaleUpperCase("fr"));
}

const NAME_PATTERN = /^\p{L}[\p{L}\p{M}' -]*$/u;

export function resolveSegment(seg: string, ctx: string): ResolveResult {
  if (ctx === "fixe") {
    const context = FIXED_CONTEXT[seg];
    if (!context) return { ok: false, error: "Segment fixe inconnu" };
    return { ok: true, ctx, kind: "fixe", input: seg, spoken: seg, ...context };
  }

  if (ctx === "id") {
    const trimmed = collapseSpaces(seg);
    if (/^\d{1,3}$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return {
        ok: true,
        ctx,
        kind: "numero",
        input: String(n),
        spoken: numberToFrenchWords(n),
        ...ID_CONTEXT,
      };
    }
    const name = canonicalName(trimmed);
    if (!name || name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
      return { ok: false, error: "Prénom invalide" };
    }
    const spoken = PHONETIC_MAP[name.toLocaleLowerCase("fr")] ?? name;
    return { ok: true, ctx, kind: "prenom", input: name, spoken, ...ID_CONTEXT };
  }

  if (ctx === "libre") {
    const text = collapseSpaces(seg);
    if (!text) return { ok: false, error: "Texte vide" };
    if (text.length > MAX_LIBRE_LENGTH) return { ok: false, error: "Texte trop long" };
    return { ok: true, ctx, kind: "libre", input: text, spoken: text };
  }

  return { ok: false, error: "Contexte inconnu" };
}

// URL d'un segment. Le paramètre v change dès que le son du segment change,
// pour contourner le cache "immutable" des tablettes :
//   - empreinte du texte prononcé : corriger un prénom ne change que l'URL
//     de ce prénom (la tablette ne retélécharge que lui) ;
//   - voiceTag, empreinte de la voix du restaurant ;
//   - TTS_PIPELINE_VERSION pour tout le reste.
// Le kiosque et le téléchargement hors-ligne doivent passer tous les deux
// par cette fonction : le cache de la tablette est indexé par URL exacte.
export function segmentUrl(r: ResolvedSegment, voiceTag: string, engine?: "piper"): string {
  const v = [TTS_PIPELINE_VERSION, shortHash(r.spoken), voiceTag].filter(Boolean).join(".");
  const params = new URLSearchParams({ seg: r.input, ctx: r.ctx, v });
  if (engine) params.set("engine", engine);
  return `/api/tts?${params.toString()}`;
}

// Raccourci pour un segment brut ; null s'il est invalide.
export function urlFor(seg: string, ctx: TtsCtx, voiceTag: string, engine?: "piper"): string | null {
  const r = resolveSegment(seg, ctx);
  return r.ok ? segmentUrl(r, voiceTag, engine) : null;
}

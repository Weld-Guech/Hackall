// Découpe une annonce en segments audio réutilisables d'un restaurant à
// l'autre : "La commande" + identifiant + "est prête." au lieu d'une phrase
// entière par prénom. Les segments fixes sont générés une seule fois pour
// tout le monde, seul l'identifiant varie.
import { FIXED, resolveSegment, ttsUrl, type TtsCtx } from "./text.ts";

export type Part = { url: string } | { pause: number };

export type Identifier = { raw: string; label: string };

export type Announcement = {
  parts: Part[];
  // Phrase complète, affichée dans l'historique et utilisée telle quelle
  // pour la version Piper de secours.
  text: string;
  // Phrase à faire lire entièrement par Piper si un segment n'est que
  // provisoire : évite d'entendre deux voix différentes dans une annonce.
  // null quand l'annonce n'a qu'un segment (rien à harmoniser).
  piperText: string | null;
  label: string;
};

// Pause marquée par la virgule entre deux identifiants d'un groupe.
const LIST_PAUSE_MS = 180;

function part(seg: string, ctx: TtsCtx, voiceTag: string): Part {
  const r = resolveSegment(seg, ctx);
  return { url: ttsUrl(r.ok ? r.input : seg, ctx, voiceTag) };
}

function spokenOf(id: Identifier): string {
  const r = resolveSegment(id.raw, "id");
  return r.ok ? r.spoken : id.raw;
}

export function fixedParts(voiceTag: string): Part[] {
  return Object.values(FIXED).map((seg) => part(seg, "fixe", voiceTag));
}

// "La commande X est prête." pour un seul identifiant, "Les commandes X, Y
// et Z sont prêtes." à partir de deux (3 au maximum côté kiosque).
export function buildIdsAnnouncement(ids: Identifier[], voiceTag: string): Announcement {
  const label = ids.map((i) => i.label).join(", ");
  const spoken = ids.map(spokenOf);

  if (ids.length === 1) {
    const text = `${FIXED.LA_COMMANDE} ${spoken[0]} ${FIXED.EST_PRETE}`;
    return {
      parts: [
        part(FIXED.LA_COMMANDE, "fixe", voiceTag),
        part(ids[0].raw, "id", voiceTag),
        part(FIXED.EST_PRETE, "fixe", voiceTag),
      ],
      text,
      piperText: text,
      label,
    };
  }

  const parts: Part[] = [part(FIXED.LES_COMMANDES, "fixe", voiceTag)];
  ids.forEach((id, i) => {
    parts.push(part(id.raw, "id", voiceTag));
    if (i < ids.length - 2) parts.push({ pause: LIST_PAUSE_MS });
    else if (i === ids.length - 2) parts.push(part(FIXED.ET, "fixe", voiceTag));
  });
  parts.push(part(FIXED.SONT_PRETES, "fixe", voiceTag));

  const joined = `${spoken.slice(0, -1).join(", ")} ${FIXED.ET} ${spoken[spoken.length - 1]}`;
  const text = `${FIXED.LES_COMMANDES} ${joined} ${FIXED.SONT_PRETES}`;
  return { parts, text, piperText: text, label };
}

// Texte libre et routines : un seul segment, prononcé tel quel.
export function buildLibreAnnouncement(text: string, label: string, voiceTag: string): Announcement {
  return {
    parts: [part(text, "libre", voiceTag)],
    text: text.trim(),
    piperText: null,
    label,
  };
}

export function piperUrl(text: string): string {
  return ttsUrl(text, "libre", "", "piper");
}

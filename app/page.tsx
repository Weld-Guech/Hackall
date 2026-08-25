"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWakeLock } from "@/hooks/useWakeLock";
import { PRENOMS_ARABES } from "@/lib/prenomsArabes";
import { PHONETIC_MAP } from "@/lib/phoneticCorrections";
import { normalizeName } from "@/lib/normalizeName";

type Ticket = {
  id: string;
  label: string;
  time: string;
  url: string;
  text: string;
};

type Routine = {
  id: string;
  label: string;
  text: string;
};

type Mode = "numero" | "libre" | "routines";

const MAX_SUGGESTIONS = 6;

// Convertit un nombre (0-999) en toutes lettres françaises, pour éviter
// que le TTS ne lise les chiffres un par un sur les nombres composés
// (125 lu "cent vingt-cinq" plutôt que "un deux cinq").
function numberToFrenchWords(n: number): string {
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

function buildAnnouncement(
  numero: string,
  prenom: string,
  texteLibre: string
): { text: string; cacheKey: string; label: string } {
  if (texteLibre.trim()) {
    const t = texteLibre.trim();
    return {
      text: t,
      cacheKey: `libre_${t}`,
      label: t.length > 28 ? `${t.slice(0, 28)}…` : t,
    };
  }
  const identifiant = prenom.trim() || numberToFrenchWords(parseInt(numero, 10) || 0);
  const spoken = PHONETIC_MAP[identifiant.toLowerCase()] ?? identifiant;
  return {
    text: `La commande ${spoken} est prête.`,
    cacheKey: prenom.trim() ? `prenom_${prenom.trim()}` : `numero_${numero}`,
    label: prenom.trim() ? prenom.trim() : `N° ${numero}`,
  };
}

type GroupEntry = {
  raw: string;
  spoken: string;
  label: string;
  key: string;
  isName: boolean;
};

// Regroupe jusqu'à 3 identifiants (prénoms et/ou numéros) dans une seule
// annonce : "La commande X est prête." pour un seul, "Les commandes X, Y
// et Z sont prêtes." à partir de deux.
function buildGroupAnnouncement(
  entries: GroupEntry[]
): { text: string; cacheKey: string; label: string } {
  if (entries.length <= 1) {
    const e = entries[0];
    return {
      text: `La commande ${e.spoken} est prête.`,
      cacheKey: e.key,
      label: e.label,
    };
  }
  const spokenList = entries.map((e) => e.spoken);
  const joined =
    spokenList.length === 2
      ? spokenList.join(" et ")
      : `${spokenList.slice(0, -1).join(", ")} et ${spokenList[spokenList.length - 1]}`;
  return {
    text: `Les commandes ${joined} sont prêtes.`,
    cacheKey: `groupe_${entries.map((e) => e.key).join("__")}`,
    label: entries.map((e) => e.label).join(", "),
  };
}

export default function Kiosk() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [numero, setNumero] = useState("");
  const [prenom, setPrenom] = useState("");
  const [texteLibre, setTexteLibre] = useState("");
  const [mode, setMode] = useState<Mode>("numero");
  const [history, setHistory] = useState<Ticket[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [restaurantName, setRestaurantName] = useState("");
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [groupItems, setGroupItems] = useState<GroupEntry[]>([]);
  const { active: wakeLockActive, supported: wakeLockSupported } = useWakeLock();
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const suggestions =
    prenom.trim().length > 0
      ? [...PRENOMS_ARABES, ...customNames]
          .filter((n) => normalizeName(n).startsWith(normalizeName(prenom.trim())))
          .slice(0, MAX_SUGGESTIONS)
      : [];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setMounted(true);
    fetch("/api/me").then(async (res) => {
      if (res.status === 403) {
        // Compte désactivé depuis l'espace agence pendant que la session
        // était encore valide côté cookie : on déconnecte proprement.
        await fetch("/api/logout", { method: "POST" });
        router.push("/login?raison=desactive");
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setClientId(data.id);
      setRestaurantName(data.restaurantName ?? "");
      setRoutines(Array.isArray(data.routines) ? data.routines : []);
      setCustomNames(Array.isArray(data.customNames) ? data.customNames : []);
    });
  }, [router]);

  // L'historique est propre à chaque client (un même appareil ne sert
  // qu'un seul compte à la fois, mais on isole quand même par identifiant).
  useEffect(() => {
    if (!clientId) return;
    try {
      const saved = window.localStorage.getItem(`appelresto_history_${clientId}`);
      if (saved) setHistory(JSON.parse(saved));
    } catch {
      // localStorage indisponible ou corrompu : on repart d'un historique vide
    }
  }, [clientId]);

  // Sauvegarde l'historique à chaque changement, pour qu'il survive à un
  // rechargement de page (utile en mode kiosque si l'écran se rafraîchit).
  useEffect(() => {
    if (!clientId) return;
    try {
      window.localStorage.setItem(`appelresto_history_${clientId}`, JSON.stringify(history));
    } catch {
      // quota localStorage dépassé ou navigation privée : on ignore
    }
  }, [history, clientId]);

  useEffect(() => {
    const update = () =>
      setClock(new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }));
    update();
    const id = setInterval(update, 15000);
    return () => clearInterval(id);
  }, []);

  // Tant que le composant n'est pas monté côté client, on force un état
  // neutre identique à celui du serveur pour éviter tout hydration mismatch.
  // En mode routines, chaque bouton déclenche l'annonce directement (un
  // clic) : pas de bouton APPELER à activer/désactiver dans ce mode.
  const canCall =
    mounted &&
    !isLoading &&
    (mode === "libre"
      ? Boolean(texteLibre.trim())
      : mode === "numero"
      ? Boolean(numero.trim() || prenom.trim() || groupItems.length > 0)
      : false);

  const audioRef = useRef<HTMLAudioElement>(null!);
  const prefetchedRef = useRef<Record<string, string>>({});

  const SILENT_WAV =
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

  useEffect(() => {
    audioRef.current = new Audio(SILENT_WAV);
  }, []);

  useEffect(() => {
    if (!canCall) return;
    const { text, cacheKey } = buildAnnouncement(numero, prenom, texteLibre);
    if (prefetchedRef.current[cacheKey]) return;

    const timer = setTimeout(() => {
      fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, cacheKey }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.url) {
            prefetchedRef.current[cacheKey] = data.url;
          }
        })
        .catch(() => {});
    }, 250);

    return () => clearTimeout(timer);
  }, [numero, prenom, texteLibre, canCall]);

  // Le "+" côté du champ prénom empile jusqu'à 3 identifiants (prénom ou
  // numéro) pour une annonce groupée ; currentEntry() lit ce qui est
  // actuellement tapé, sans encore l'ajouter au groupe.
  function currentEntry(): GroupEntry | null {
    if (prenom.trim()) {
      const raw = prenom.trim();
      return {
        raw,
        spoken: PHONETIC_MAP[raw.toLowerCase()] ?? raw,
        label: raw,
        key: `prenom_${raw}`,
        isName: true,
      };
    }
    if (numero.trim()) {
      const raw = numero.trim();
      return {
        raw,
        spoken: numberToFrenchWords(parseInt(raw, 10) || 0),
        label: `N° ${raw}`,
        key: `numero_${raw}`,
        isName: false,
      };
    }
    return null;
  }

  function addToGroup() {
    const entry = currentEntry();
    if (!entry || groupItems.length >= 3) return;
    setGroupItems((g) => [...g, entry]);
    setNumero("");
    setPrenom("");
    setShowSuggestions(false);
  }

  function removeFromGroup(index: number) {
    setGroupItems((g) => g.filter((_, i) => i !== index));
  }

  async function announce(text: string, cacheKey: string, label: string): Promise<boolean> {
    setError(null);
    setIsLoading(true);

    const audio = audioRef.current;

    // Priming systematique : on remet la source sur un silence
    // (jamais sur l'audio reel precedent, qui pourrait etre relance et
    // creer un conflit avec le vrai audio qui va suivre), et on tente
    // une lecture des le tout debut, avant tout await.
    audio.src = SILENT_WAV;
    audio.play().catch(() => {});

    try {
      const cached = prefetchedRef.current[cacheKey];
      let url: string;
      if (cached) {
        url = cached;
      } else {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, cacheKey }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Erreur inconnue");
        url = data.url;
      }
      audio.src = url;
      audio.play().catch(() => {});

      setHistory((prev) => [
        {
          id: `${Date.now()}`,
          label,
          time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
          url,
          text,
        },
        ...prev,
      ].slice(0, 12));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'annonce");
      return false;
    } finally {
      setIsLoading(false);
    }
  }

  // Un prénom tapé qui n'est ni dans la liste suggérée ni déjà appris est
  // enregistré silencieusement pour ce client : il sera suggéré la
  // prochaine fois. Appelé seulement après une annonce réussie.
  async function learnNameIfNew(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const known = [...PRENOMS_ARABES, ...customNames].some(
      (n) => normalizeName(n) === normalizeName(trimmed)
    );
    if (known) return;
    try {
      const res = await fetch("/api/prenoms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prenom: trimmed }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.customNames)) setCustomNames(data.customNames);
    } catch {
      // Best-effort : un raté ici ne doit jamais bloquer le kiosque.
    }
  }

  async function handleCall() {
    if (!canCall) return;

    if (mode === "libre") {
      const { text, cacheKey, label } = buildAnnouncement(numero, prenom, texteLibre);
      await announce(text, cacheKey, label);
      setTexteLibre("");
      return;
    }

    // Mode numéro/prénom : on inclut ce qui est encore tapé (non ajouté via
    // le "+") comme dernier élément du groupe, dans la limite de 3.
    const current = currentEntry();
    const entries =
      groupItems.length >= 3 ? groupItems : [...groupItems, ...(current ? [current] : [])];
    if (entries.length === 0) return;

    const { text, cacheKey, label } = buildGroupAnnouncement(entries);
    const ok = await announce(text, cacheKey, label);
    if (ok) {
      entries.forEach((e) => {
        if (e.isName) learnNameIfNew(e.raw);
      });
    }
    setNumero("");
    setPrenom("");
    setGroupItems([]);
  }

  async function handleRoutineCall(routine: Routine) {
    if (isLoading) return;
    await announce(routine.text, `routine_${routine.text}`, routine.label);
  }

  async function handleReplay(ticket: Ticket) {
    setError(null);
    try {
      // Le fichier est déjà généré et mis en cache côté serveur : on le
      // rejoue directement, aucun appel à l'API ElevenLabs n'est fait.
      audioRef.current.src = ticket.url;
      await audioRef.current.play();
    } catch {
      setError("Impossible de rejouer cette annonce.");
    }
  }

  function pressDigit(d: string) {
    if (numero.length >= 3) return;
    setNumero((n) => n + d);
  }

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <span style={styles.eyebrow}>
          {(restaurantName || "…").toUpperCase()} · COMPTOIR
        </span>
        <div style={styles.headerRight}>
          <span style={styles.clock}>{clock}</span>
          <button style={styles.headerButton} onClick={() => router.push("/parametres")}>
            Réglages
          </button>
          <button style={styles.headerButton} onClick={handleLogout}>
            Déconnexion
          </button>
        </div>
      </header>

      <div style={styles.body}>
        <section style={styles.left}>
          <div style={styles.modeToggle}>
            <button
              style={{
                ...styles.modeButton,
                ...(mode === "numero" ? styles.modeButtonActive : {}),
              }}
              onClick={() => setMode("numero")}
            >
              Numéro / Prénom
            </button>
            <button
              style={{
                ...styles.modeButton,
                ...(mode === "libre" ? styles.modeButtonActive : {}),
              }}
              onClick={() => setMode("libre")}
            >
              Texte libre
            </button>
            <button
              style={{
                ...styles.modeButton,
                ...(mode === "routines" ? styles.modeButtonActive : {}),
              }}
              onClick={() => setMode("routines")}
            >
              Routines
            </button>
          </div>

          {mode === "libre" ? (
            <div style={styles.libreWrap}>
              <textarea
                style={styles.libreInput}
                placeholder="Tape exactement ce qui doit être annoncé…"
                value={texteLibre}
                onChange={(e) => setTexteLibre(e.target.value)}
                rows={4}
              />
              <p style={styles.hint}>
                En mode texte libre, la phrase automatique n'est pas ajoutée — seul ce que tu tapes ici sera prononcé.
              </p>
            </div>
          ) : mode === "routines" ? (
            <div style={styles.routinesWrap}>
              {routines.length === 0 ? (
                <p style={styles.hint}>
                  Aucune routine enregistrée. Ajoute des phrases toutes faites depuis{" "}
                  <button
                    type="button"
                    style={styles.inlineLink}
                    onClick={() => router.push("/parametres")}
                  >
                    Réglages
                  </button>
                  , tu pourras ensuite les déclencher ici en un clic.
                </p>
              ) : (
                <div style={styles.routinesGrid}>
                  {routines.map((r) => (
                    <button
                      key={r.id}
                      style={{ ...styles.routineButton, opacity: isLoading ? 0.5 : 1 }}
                      onClick={() => handleRoutineCall(r)}
                      disabled={isLoading}
                      title={r.text}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div style={styles.display}>
                <span style={styles.displayValue}>{numero || "—"}</span>
                <div style={styles.prenomRow}>
                  <div style={styles.prenomWrap} ref={suggestionsRef}>
                    <input
                      style={styles.prenomInput}
                      placeholder="ou saisir un prénom"
                      value={prenom}
                      onChange={(e) => {
                        setPrenom(e.target.value);
                        setNumero("");
                        setShowSuggestions(true);
                      }}
                      onFocus={() => setShowSuggestions(true)}
                    />
                    {showSuggestions && suggestions.length > 0 && (
                      <div style={styles.suggestionList}>
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            style={styles.suggestionItem}
                            onClick={() => {
                              setPrenom(s);
                              setShowSuggestions(false);
                            }}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    style={{
                      ...styles.groupAddButton,
                      opacity: !currentEntry() || groupItems.length >= 3 ? 0.4 : 1,
                    }}
                    onClick={addToGroup}
                    disabled={!currentEntry() || groupItems.length >= 3}
                    title="Ajouter à une commande groupée (max 3)"
                  >
                    +
                  </button>
                </div>

                {groupItems.length > 0 && (
                  <div style={styles.groupChips}>
                    {groupItems.map((g, i) => (
                      <span key={`${g.key}_${i}`} style={styles.chip}>
                        {g.label}
                        <button
                          type="button"
                          style={styles.chipRemove}
                          onClick={() => removeFromGroup(i)}
                          title="Retirer du groupe"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div style={styles.keypad}>
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                  <button key={d} style={styles.key} onClick={() => pressDigit(d)}>
                    {d}
                  </button>
                ))}
                <button
                  style={styles.key}
                  onClick={() => {
                    setNumero("");
                    setPrenom("");
                  }}
                >
                  Effacer
                </button>
                <button style={styles.key} onClick={() => pressDigit("0")}>
                  0
                </button>
                <button
                  style={styles.key}
                  onClick={() => setNumero((n) => n.slice(0, -1))}
                >
                  ⌫
                </button>
              </div>
            </>
          )}

          {mode !== "routines" && (
            <button
              style={{ ...styles.callButton, opacity: canCall ? 1 : 0.4 }}
              onClick={handleCall}
              disabled={!canCall}
            >
              {isLoading ? "Annonce en cours…" : "APPELER"}
            </button>
          )}

          {error && <p style={styles.error}>{error}</p>}
          {wakeLockSupported && !wakeLockActive && (
            <p style={styles.hint}>Écran non verrouillé actif — touchez l'écran pour réactiver.</p>
          )}
        </section>

        <aside style={styles.rail}>
          <span style={styles.railTitle}>Dernières annonces</span>
          <div style={styles.railList}>
            {history.length === 0 && (
              <p style={styles.railEmpty}>Aucune annonce pour l'instant.</p>
            )}
            {history.map((t) => (
              <button
                key={t.id}
                style={styles.ticket}
                onClick={() => handleReplay(t)}
                title="Rejouer cette annonce"
              >
                <span style={styles.ticketHole} />
                <span style={styles.ticketLabel}>{t.label}</span>
                <span style={styles.ticketTime}>{t.time}</span>
                <span style={styles.replayIcon}>↻</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100dvh",
    display: "flex",
    flexDirection: "column",
    padding: "24px 32px",
    gap: 24,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  eyebrow: {
    fontFamily: "var(--font-body)",
    fontSize: 13,
    letterSpacing: "0.12em",
    color: "var(--text-muted)",
    fontWeight: 600,
  },
  clock: {
    fontFamily: "var(--font-display)",
    fontSize: 20,
    color: "var(--text-muted)",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  headerButton: {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text-muted)",
    fontFamily: "var(--font-body)",
    fontSize: 12,
    padding: "8px 12px",
    cursor: "pointer",
  },
  body: {
    display: "flex",
    gap: 24,
    flex: 1,
  },
  left: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 20,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 28,
  },
  modeToggle: {
    display: "flex",
    gap: 8,
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: 4,
  },
  modeButton: {
    flex: 1,
    background: "transparent",
    border: "none",
    borderRadius: 8,
    color: "var(--text-muted)",
    fontFamily: "var(--font-body)",
    fontSize: 14,
    fontWeight: 600,
    padding: "10px 0",
    cursor: "pointer",
  },
  modeButtonActive: {
    background: "var(--bg)",
    color: "var(--text)",
  },
  libreWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    flex: 1,
  },
  routinesWrap: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
  },
  routinesGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: 12,
    alignContent: "start",
  },
  routineButton: {
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 16,
    fontWeight: 600,
    padding: "20px 16px",
    cursor: "pointer",
    textAlign: "center",
  },
  inlineLink: {
    background: "transparent",
    border: "none",
    color: "var(--accent)",
    fontFamily: "var(--font-body)",
    fontSize: "inherit",
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
  },
  libreInput: {
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 20,
    padding: 16,
    resize: "none",
  },
  display: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    padding: "24px 0",
  },
  displayValue: {
    fontFamily: "var(--font-display)",
    fontSize: 96,
    lineHeight: 1,
    fontWeight: 600,
    letterSpacing: "0.02em",
    color: "var(--text)",
  },
  prenomRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  prenomWrap: {
    position: "relative",
    width: 260,
  },
  groupAddButton: {
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 20,
    lineHeight: 1,
    cursor: "pointer",
  },
  groupChips: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    maxWidth: 320,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    padding: "6px 8px 6px 12px",
  },
  chipRemove: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    fontSize: 15,
    lineHeight: 1,
    cursor: "pointer",
    padding: 0,
  },
  prenomInput: {
    background: "transparent",
    border: "none",
    borderBottom: "2px solid var(--border)",
    color: "var(--ticket)",
    fontFamily: "var(--font-body)",
    fontSize: 20,
    textAlign: "center",
    padding: "6px 12px",
    width: "100%",
  },
  suggestionList: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    zIndex: 10,
    marginTop: 4,
    display: "flex",
    flexDirection: "column",
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    overflow: "hidden",
    maxHeight: 260,
    overflowY: "auto",
  },
  suggestionItem: {
    background: "transparent",
    border: "none",
    borderBottom: "1px solid var(--border)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 16,
    padding: "10px 12px",
    textAlign: "center",
    cursor: "pointer",
    font: "inherit",
  },
  keypad: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 12,
  },
  key: {
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    color: "var(--text)",
    fontFamily: "var(--font-display)",
    fontSize: 28,
    padding: "20px 0",
    cursor: "pointer",
  },
  callButton: {
    background: "var(--accent)",
    border: "none",
    borderRadius: 14,
    color: "#1c1b1a",
    fontFamily: "var(--font-display)",
    fontSize: 26,
    fontWeight: 600,
    letterSpacing: "0.06em",
    padding: "22px 0",
    cursor: "pointer",
  },
  error: {
    color: "#d97757",
    fontSize: 14,
    textAlign: "center",
  },
  hint: {
    color: "var(--text-muted)",
    fontSize: 12,
    textAlign: "center",
  },
  rail: {
    width: 280,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  railTitle: {
    fontFamily: "var(--font-body)",
    fontSize: 12,
    letterSpacing: "0.1em",
    color: "var(--text-muted)",
    fontWeight: 600,
  },
  railList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    overflowY: "auto",
  },
  railEmpty: {
    color: "var(--text-muted)",
    fontSize: 13,
  },
  ticket: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "var(--surface-raised)",
    border: "1px dashed var(--border)",
    borderRadius: 8,
    padding: "10px 12px",
    width: "100%",
    cursor: "pointer",
    textAlign: "left",
    font: "inherit",
  },
  replayIcon: {
    fontSize: 16,
    color: "var(--text-muted)",
    flexShrink: 0,
  },
  ticketHole: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    flexShrink: 0,
  },
  ticketLabel: {
    flex: 1,
    fontFamily: "var(--font-display)",
    fontSize: 18,
    color: "var(--ticket)",
  },
  ticketTime: {
    fontSize: 12,
    color: "var(--text-muted)",
  },
};

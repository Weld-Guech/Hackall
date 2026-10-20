"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWakeLock } from "@/hooks/useWakeLock";
import { PRENOMS_ARABES } from "@/lib/prenomsArabes";
import { normalizeName } from "@/lib/normalizeName";
import { resumeWithTimeout } from "@/lib/audioPlayback";
import { SegmentPlayer, type LoadedPart } from "@/lib/audio/segmentPlayer";
import { shortHash } from "@/lib/tts/text";
import {
  buildIdsAnnouncement,
  buildLibreAnnouncement,
  fixedParts,
  piperUrl,
  type Announcement,
  type Part,
} from "@/lib/tts/segments";

type Ticket = {
  id: string;
  label: string;
  time: string;
  // Anciennes annonces (phrase entière) : une seule URL. Nouvelles : la
  // liste des segments, rejouée à l'identique.
  url?: string;
  parts?: Part[];
  piperText?: string | null;
  text: string;
};

type Routine = {
  id: string;
  label: string;
  text: string;
};

type Mode = "numero" | "libre" | "routines";

const MAX_SUGGESTIONS = 6;

// Un identifiant d'annonce (prénom ou numéro), seul ou dans un groupe de 3
// au maximum ("Les commandes X, Y et Z sont prêtes.").
type GroupEntry = {
  raw: string;
  label: string;
  key: string;
  isName: boolean;
};

function libreLabel(t: string): string {
  return t.length > 28 ? `${t.slice(0, 28)}…` : t;
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
  const [debug, setDebug] = useState<string>(""); // ligne de diagnostic à l'écran
  const [clock, setClock] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const [restaurantName, setRestaurantName] = useState("");
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [groupItems, setGroupItems] = useState<GroupEntry[]>([]);
  const { active: wakeLockActive, supported: wakeLockSupported } = useWakeLock();
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // --- Web Audio API ---------------------------------------------------
  // Un seul AudioContext (dans SegmentPlayer), débloqué par le bouton
  // "Démarrer le service" : sur iOS, aucun son n'est possible avant un geste
  // utilisateur, et un déblocage "au premier contact n'importe où" laissait
  // le kiosque muet tant que personne n'avait touché l'écran.
  const playerRef = useRef<SegmentPlayer | null>(null);
  const [serviceStarted, setServiceStarted] = useState(false);
  const [audioState, setAudioState] = useState<string>("suspended");
  // Empreinte de la voix du restaurant, ajoutée aux URL de segments.
  const [voiceTag, setVoiceTag] = useState<string | null>(null);
  // File de lecture unique : chaque annonce attend la fin de la précédente
  // au lieu de la couper (ou d'être ignorée). Le téléchargement, lui, démarre
  // tout de suite, en parallèle de la lecture en cours.
  const playQueueRef = useRef<Promise<void>>(Promise.resolve());

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
        await fetch("/api/logout", { method: "POST" });
        router.push("/login?raison=desactive");
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setClientId(data.id);
      setRestaurantName(data.restaurantName ?? "");
      setVoiceTag(shortHash(typeof data.voiceId === "string" ? data.voiceId : ""));
      setRoutines(Array.isArray(data.routines) ? data.routines : []);
      setCustomNames(Array.isArray(data.customNames) ? data.customNames : []);
    });
  }, [router]);

  useEffect(() => {
    if (!clientId) return;
    try {
      const saved = window.localStorage.getItem(`appelresto_history_${clientId}`);
      if (saved) setHistory(JSON.parse(saved));
    } catch {
      // localStorage indisponible ou corrompu : on repart d'un historique vide
    }
  }, [clientId]);

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

  const canCall =
    mounted &&
    !isLoading &&
    (mode === "libre"
      ? Boolean(texteLibre.trim())
      : mode === "numero"
      ? Boolean(numero.trim() || prenom.trim() || groupItems.length > 0)
      : false);

  // Appelé uniquement depuis un geste utilisateur (bouton de démarrage,
  // bandeau de réactivation, tout contact avec l'écran).
  async function unlockAudio(): Promise<boolean> {
    if (!playerRef.current) {
      playerRef.current = SegmentPlayer.create();
      if (!playerRef.current) {
        setError("Audio non supporté sur ce navigateur.");
        return false;
      }
      const ctx = playerRef.current.ctx;
      ctx.addEventListener("statechange", () => setAudioState(ctx.state));
    }
    const ok = await playerRef.current.unlock();
    setAudioState(playerRef.current.ctx.state);
    return ok;
  }

  async function startService() {
    await unlockAudio();
    setServiceStarted(true);
  }

  useEffect(() => {
    if (!serviceStarted) return;
    // Tout contact avec l'écran réveille le son s'il a été coupé (veille
    // iOS, appel entrant...) : resume() n'est accepté que pendant un geste.
    const onTouch = () => {
      const player = playerRef.current;
      if (player && !player.running) void unlockAudio();
    };
    // Au retour sur l'onglet, on tente un réveil sans geste ; s'il est
    // refusé, le bandeau "Toucher pour réactiver le son" s'affiche.
    const onVisible = () => {
      const player = playerRef.current;
      if (document.visibilityState !== "visible" || !player) return;
      if (!player.running) player.ctx.resume().catch(() => {});
      setAudioState(player.ctx.state);
    };
    window.addEventListener("pointerdown", onTouch);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pointerdown", onTouch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [serviceStarted]);

  // Précharge les segments fixes ("La commande", "est prête."...) dès que
  // le service est démarré et la voix du restaurant connue.
  useEffect(() => {
    const player = playerRef.current;
    if (!serviceStarted || voiceTag === null || !player) return;
    fixedParts(voiceTag).forEach((p) => {
      if ("url" in p) player.load(p.url).catch(() => {});
    });
  }, [serviceStarted, voiceTag]);

  // Précharge le segment d'un numéro pendant la saisie (les prénoms ne sont
  // préchargés qu'une fois choisis dans les suggestions : précharger "Ray",
  // "Raya"... déclencherait des générations inutiles).
  useEffect(() => {
    const player = playerRef.current;
    if (!player || voiceTag === null || mode !== "numero" || prenom.trim()) return;
    if (!/^\d{1,3}$/.test(numero)) return;
    const timer = setTimeout(() => prefetchIdentifier(numero), 250);
    return () => clearTimeout(timer);
  }, [numero, prenom, mode, voiceTag]);

  function prefetchIdentifier(raw: string) {
    const player = playerRef.current;
    if (!player || voiceTag === null) return;
    const [, idPart] = buildIdsAnnouncement([{ raw, label: raw }], voiceTag).parts;
    if (idPart && "url" in idPart) player.load(idPart.url).catch(() => {});
  }

  function currentEntry(): GroupEntry | null {
    if (prenom.trim()) {
      const raw = prenom.trim();
      return { raw, label: raw, key: `prenom_${raw}`, isName: true };
    }
    if (numero.trim()) {
      const raw = numero.trim();
      return { raw, label: `N° ${raw}`, key: `numero_${raw}`, isName: false };
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

  // Télécharge les segments d'une annonce. Si l'un d'eux n'est qu'une
  // version provisoire (Piper, ElevenLabs indisponible), toute la phrase est
  // relue par Piper pour ne pas mélanger deux voix ; si cette relecture
  // échoue, on joue quand même les segments tels quels.
  async function loadAnnouncement(
    player: SegmentPlayer,
    a: Pick<Announcement, "parts" | "piperText">
  ): Promise<{ parts: LoadedPart[]; provisional: boolean }> {
    const parts = await player.loadAll(a.parts);
    const provisional = parts.some((p) => "buffer" in p && !p.final);
    if (provisional && a.piperText) {
      try {
        return { parts: [await player.load(piperUrl(a.piperText))], provisional };
      } catch {
        // on garde le mélange de voix plutôt que le silence
      }
    }
    return { parts, provisional };
  }

  // Ajoute une lecture à la file : elle démarre dès que la précédente est
  // terminée et que ses propres segments sont prêts, dans l'ordre des clics.
  function enqueuePlayback(
    player: SegmentPlayer,
    partsPromise: Promise<LoadedPart[]>,
    onStart?: () => void
  ): Promise<void> {
    const previous = playQueueRef.current;
    const mine = (async () => {
      const parts = await partsPromise;
      await previous;
      if (!player.running) {
        await resumeWithTimeout(() => player.ctx.resume());
      }
      onStart?.();
      await player.play(parts);
    })();
    playQueueRef.current = mine.catch(() => {});
    return mine;
  }

  async function announce(a: Announcement): Promise<boolean> {
    // Mesure de latence (console + ligne de debug à l'écran) :
    // clic → premier son, attente de la file incluse.
    const clicked = performance.now();
    setError(null);

    const player = playerRef.current;
    if (!player) {
      setError("Touchez « Démarrer le service » pour activer le son.");
      return false;
    }
    setIsLoading(true);

    // On réveille le contexte dans le geste (le clic qui a déclenché
    // announce). C'est le point clé sur iPad.
    if (!player.running) await resumeWithTimeout(() => player.ctx.resume());

    // La place dans la file est réservée dès le clic, pendant que le
    // téléchargement tourne : l'ordre des annonces suit l'ordre des clics.
    const loading = loadAnnouncement(player, a);
    enqueuePlayback(
      player,
      loading.then((l) => l.parts),
      () => {
        const firstSoundMs = Math.round(performance.now() - clicked);
        loading.then(({ provisional }) => {
          console.info("[annonce]", { first_sound_ms: firstSoundMs, provisional });
          setDebug(
            `ctx=${player.ctx.state} · premier son ${firstSoundMs} ms (attente file incluse)${
              provisional ? " · voix de secours" : ""
            }`
          );
        });
      }
    ).catch(() => {
      // L'échec du téléchargement est déjà affiché ci-dessous.
    });

    try {
      await loading;
      setHistory((prev) => [
        {
          id: `${Date.now()}`,
          label: a.label,
          time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
          parts: a.parts,
          piperText: a.piperText,
          text: a.text,
        },
        ...prev,
      ].slice(0, 12));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Échec de l'annonce";
      setError(msg);
      setDebug(`ERREUR: ${msg} (ctx=${player.ctx.state})`);
      return false;
    } finally {
      setIsLoading(false);
    }
  }

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
    const tag = voiceTag ?? "";

    if (mode === "libre") {
      const t = texteLibre.trim();
      await announce(buildLibreAnnouncement(t, libreLabel(t), tag));
      setTexteLibre("");
      return;
    }

    const current = currentEntry();
    const entries =
      groupItems.length >= 3 ? groupItems : [...groupItems, ...(current ? [current] : [])];
    if (entries.length === 0) return;

    const ok = await announce(buildIdsAnnouncement(entries, tag));
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
    await announce(buildLibreAnnouncement(routine.text, routine.label, voiceTag ?? ""));
  }

  async function handleReplay(ticket: Ticket) {
    setError(null);
    const player = playerRef.current;
    if (!player) {
      setError("Touchez « Démarrer le service » pour activer le son.");
      return;
    }
    try {
      if (!player.running) await resumeWithTimeout(() => player.ctx.resume());
      const parts = ticket.parts
        ? loadAnnouncement(player, { parts: ticket.parts, piperText: ticket.piperText ?? null }).then(
            (l) => l.parts
          )
        : player.loadAll(ticket.url ? [{ url: ticket.url }] : []);
      await enqueuePlayback(player, parts);
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
      {mounted && !serviceStarted && (
        <div style={styles.startOverlay}>
          <span style={styles.eyebrow}>{(restaurantName || "…").toUpperCase()}</span>
          <button style={styles.startButton} onClick={startService}>
            Démarrer le service
          </button>
          <p style={styles.hint}>Active le son des annonces sur cet appareil.</p>
        </div>
      )}
      {serviceStarted && audioState !== "running" && (
        <button style={styles.audioBanner} onClick={() => void unlockAudio()}>
          🔇 Toucher pour réactiver le son
        </button>
      )}
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
                              prefetchIdentifier(s);
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
          {debug && <p style={styles.debug}>{debug}</p>}
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
  startOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 100,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    background: "var(--bg)",
  },
  startButton: {
    background: "var(--accent)",
    border: "none",
    borderRadius: 16,
    color: "#1c1b1a",
    fontFamily: "var(--font-display)",
    fontSize: 32,
    fontWeight: 600,
    letterSpacing: "0.04em",
    padding: "28px 48px",
    cursor: "pointer",
  },
  audioBanner: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 90,
    background: "#d97757",
    border: "none",
    color: "#1c1b1a",
    fontFamily: "var(--font-body)",
    fontSize: 18,
    fontWeight: 700,
    padding: "16px 0",
    cursor: "pointer",
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
  debug: {
    color: "var(--text-muted)",
    fontSize: 11,
    fontFamily: "monospace",
    textAlign: "center",
    opacity: 0.7,
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

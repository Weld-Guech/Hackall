"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Routine = {
  id: string;
  label: string;
  text: string;
};

const MAX_ROUTINES = 12;

export default function ParametresPage() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesError, setRoutinesError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newText, setNewText] = useState("");
  const [addingRoutine, setAddingRoutine] = useState(false);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editText, setEditText] = useState("");

  useEffect(() => {
    fetch("/api/me").then(async (res) => {
      if (res.status === 403) {
        await fetch("/api/logout", { method: "POST" });
        router.push("/login?raison=desactive");
        return;
      }
      if (!res.ok) {
        setError("Impossible de charger tes informations");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setLogin(data.login ?? "");
      setRestaurantName(data.restaurantName ?? "");
      setVoiceId(data.voiceId ?? "");
      setRoutines(Array.isArray(data.routines) ? data.routines : []);
      setLoading(false);
    });
  }, [router]);

  async function handleAddRoutine(e: React.FormEvent) {
    e.preventDefault();
    setRoutinesError(null);
    setAddingRoutine(true);
    try {
      const res = await fetch("/api/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel, text: newText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erreur inconnue");
      setRoutines((prev) => [...prev, data]);
      setNewLabel("");
      setNewText("");
    } catch (err) {
      setRoutinesError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setAddingRoutine(false);
    }
  }

  async function handleSaveRoutine(id: string) {
    setRoutinesError(null);
    try {
      const res = await fetch(`/api/routines/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: editLabel, text: editText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erreur inconnue");
      setRoutines((prev) => prev.map((r) => (r.id === id ? data : r)));
      setEditTarget(null);
    } catch (err) {
      setRoutinesError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  }

  async function handleDeleteRoutine(id: string) {
    if (!window.confirm("Supprimer cette routine ?")) return;
    setRoutinesError(null);
    try {
      const res = await fetch(`/api/routines/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Suppression impossible");
      setRoutines((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setRoutinesError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restaurantName, voiceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erreur inconnue");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'enregistrement");
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  if (loading) {
    return (
      <main style={styles.main}>
        <p style={styles.hint}>Chargement…</p>
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <span style={styles.eyebrow}>{login.toUpperCase()}</span>
          <h1 style={styles.title}>Réglages</h1>
        </div>
        <button style={styles.ghostButton} onClick={() => router.push("/")}>
          Retour au kiosque
        </button>
      </header>

      <form style={styles.card} onSubmit={handleSave}>
        <label style={styles.label}>
          Nom du restaurant
          <input
            style={styles.input}
            value={restaurantName}
            onChange={(e) => setRestaurantName(e.target.value)}
            required
          />
        </label>

        <label style={styles.label}>
          Voice ID ElevenLabs
          <input
            style={styles.input}
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            placeholder="vide = voix par défaut de l'agence"
          />
        </label>

        {error && <p style={styles.error}>{error}</p>}
        {saved && <p style={styles.success}>Enregistré.</p>}

        <button style={styles.button} type="submit" disabled={saving}>
          {saving ? "Enregistrement…" : "Enregistrer"}
        </button>
      </form>

      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Routines</h2>
        <p style={styles.cardHint}>
          Des phrases toutes faites, déclenchables en un clic depuis l&apos;onglet
          « Routines » du kiosque (annonce fermeture, rappel, etc.).
        </p>

        {routines.length > 0 && (
          <div style={styles.routineList}>
            {routines.map((r) =>
              editTarget === r.id ? (
                <div key={r.id} style={styles.routineEditRow}>
                  <input
                    style={styles.input}
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    placeholder="Titre du bouton"
                  />
                  <textarea
                    style={styles.textarea}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={2}
                    placeholder="Phrase annoncée"
                  />
                  <div style={styles.routineRowActions}>
                    <button style={styles.smallButton} onClick={() => handleSaveRoutine(r.id)}>
                      Enregistrer
                    </button>
                    <button style={styles.smallButtonGhost} onClick={() => setEditTarget(null)}>
                      Annuler
                    </button>
                  </div>
                </div>
              ) : (
                <div key={r.id} style={styles.routineRow}>
                  <div style={styles.routineRowInfo}>
                    <span style={styles.routineLabel}>{r.label}</span>
                    <span style={styles.routineText}>{r.text}</span>
                  </div>
                  <div style={styles.routineRowActions}>
                    <button
                      style={styles.smallButtonGhost}
                      onClick={() => {
                        setEditTarget(r.id);
                        setEditLabel(r.label);
                        setEditText(r.text);
                      }}
                    >
                      Modifier
                    </button>
                    <button style={styles.smallButtonDanger} onClick={() => handleDeleteRoutine(r.id)}>
                      Supprimer
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        )}

        {routines.length >= MAX_ROUTINES ? (
          <p style={styles.hint}>Limite de {MAX_ROUTINES} routines atteinte.</p>
        ) : (
          <form style={styles.form} onSubmit={handleAddRoutine}>
            <label style={styles.label}>
              Titre du bouton
              <input
                style={styles.input}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Ex. Fermeture dans 10 min"
                required
              />
            </label>
            <label style={styles.label}>
              Phrase annoncée
              <textarea
                style={styles.textarea}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                rows={2}
                placeholder="Ex. Le restaurant ferme ses portes dans dix minutes."
                required
              />
            </label>
            <button style={styles.smallButton} type="submit" disabled={addingRoutine}>
              {addingRoutine ? "Ajout…" : "Ajouter la routine"}
            </button>
          </form>
        )}

        {routinesError && <p style={styles.error}>{routinesError}</p>}
      </section>

      <button style={styles.logoutButton} onClick={handleLogout}>
        Déconnexion
      </button>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100dvh",
    display: "flex",
    flexDirection: "column",
    gap: 24,
    padding: "32px 24px",
    maxWidth: 480,
    margin: "0 auto",
    width: "100%",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  eyebrow: {
    fontFamily: "var(--font-body)",
    fontSize: 13,
    letterSpacing: "0.12em",
    color: "var(--text-muted)",
    fontWeight: 600,
  },
  title: {
    fontFamily: "var(--font-display)",
    fontSize: 28,
    margin: "4px 0 0",
    color: "var(--text)",
  },
  ghostButton: {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text-muted)",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    padding: "10px 14px",
    cursor: "pointer",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 24,
  },
  cardTitle: {
    fontFamily: "var(--font-display)",
    fontSize: 20,
    margin: 0,
    color: "var(--text)",
  },
  cardHint: {
    color: "var(--text-muted)",
    fontSize: 13,
    margin: "-8px 0 0",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  textarea: {
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 14,
    padding: "10px 12px",
    resize: "none",
  },
  routineList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  routineRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    flexWrap: "wrap",
  },
  routineEditRow: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: 12,
  },
  routineRowInfo: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  routineRowActions: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  routineLabel: {
    fontFamily: "var(--font-display)",
    fontSize: 15,
    color: "var(--text)",
  },
  routineText: {
    fontFamily: "var(--font-body)",
    fontSize: 12,
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 280,
  },
  smallButton: {
    background: "var(--accent)",
    border: "none",
    borderRadius: 8,
    color: "#1c1b1a",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    fontWeight: 600,
    padding: "8px 14px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    alignSelf: "flex-start",
  },
  smallButtonGhost: {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text-muted)",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    padding: "6px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  smallButtonDanger: {
    background: "transparent",
    border: "1px solid #d97757",
    borderRadius: 8,
    color: "#d97757",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    padding: "6px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontFamily: "var(--font-body)",
    fontSize: 13,
    color: "var(--text-muted)",
  },
  input: {
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 15,
    padding: "10px 12px",
  },
  button: {
    background: "var(--accent)",
    border: "none",
    borderRadius: 12,
    color: "#1c1b1a",
    fontFamily: "var(--font-display)",
    fontSize: 16,
    fontWeight: 600,
    padding: "12px 0",
    cursor: "pointer",
  },
  logoutButton: {
    alignSelf: "flex-start",
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    textDecoration: "underline",
    cursor: "pointer",
    padding: 0,
  },
  error: {
    color: "#d97757",
    fontSize: 14,
    margin: 0,
  },
  success: {
    color: "var(--success)",
    fontSize: 14,
    margin: 0,
  },
  hint: {
    color: "var(--text-muted)",
    fontSize: 14,
  },
};

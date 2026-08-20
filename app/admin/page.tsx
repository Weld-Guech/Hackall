"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Client = {
  id: string;
  login: string;
  restaurantName: string;
  voiceId: string;
  active: boolean;
  createdAt: string;
};

function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export default function AdminPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [restaurantName, setRestaurantName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [creating, setCreating] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ login: string; password: string } | null>(null);

  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  async function loadClients() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/clients");
      if (!res.ok) throw new Error("Impossible de charger les clients");
      setClients(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadClients();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restaurantName, login, password, voiceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erreur inconnue");
      setLastCreated({ login, password });
      setRestaurantName("");
      setLogin("");
      setPassword("");
      setVoiceId("");
      await loadClients();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Supprimer l'accès de "${name}" ? Cette action est définitive.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/admin/clients/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Suppression impossible");
      await loadClients();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  }

  async function handleToggleActive(c: Client) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/clients/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !c.active }),
      });
      if (!res.ok) throw new Error("Mise à jour impossible");
      await loadClients();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  }

  async function handleResetPassword(id: string) {
    if (resetPassword.length < 6) {
      setError("Le mot de passe doit faire au moins 6 caractères");
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/admin/clients/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword }),
      });
      if (!res.ok) throw new Error("Réinitialisation impossible");
      setResetTarget(null);
      setResetPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <span style={styles.eyebrow}>APPELRESTO · AGENCE</span>
          <h1 style={styles.title}>Comptes clients</h1>
        </div>
        <button style={styles.logoutButton} onClick={handleLogout}>
          Déconnexion
        </button>
      </header>

      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Créer un accès</h2>
        <form style={styles.form} onSubmit={handleCreate}>
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
            Identifiant
            <input
              style={styles.input}
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              required
            />
          </label>
          <label style={styles.label}>
            Mot de passe
            <div style={styles.inline}>
              <input
                style={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
              <button
                type="button"
                style={styles.smallButton}
                onClick={() => setPassword(randomPassword())}
              >
                Générer
              </button>
            </div>
          </label>
          <label style={styles.label}>
            Voice ID ElevenLabs (optionnel)
            <input
              style={styles.input}
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              placeholder="vide = voix par défaut de l'agence"
            />
          </label>

          <button style={styles.button} type="submit" disabled={creating}>
            {creating ? "Création…" : "Créer l'accès"}
          </button>
        </form>

        {lastCreated && (
          <p style={styles.success}>
            Compte créé — identifiant <strong>{lastCreated.login}</strong>, mot de passe{" "}
            <strong>{lastCreated.password}</strong>. Transmets ces informations au client
            maintenant : le mot de passe ne sera plus jamais affiché.
          </p>
        )}
        {error && <p style={styles.error}>{error}</p>}
      </section>

      <section style={styles.card}>
        <h2 style={styles.cardTitle}>Clients ({clients.length})</h2>
        {loading ? (
          <p style={styles.hint}>Chargement…</p>
        ) : clients.length === 0 ? (
          <p style={styles.hint}>Aucun client pour l&apos;instant.</p>
        ) : (
          <div style={styles.list}>
            {clients.map((c) => (
              <div key={c.id} style={{ ...styles.row, opacity: c.active ? 1 : 0.6 }}>
                <div style={styles.rowInfo}>
                  <div style={styles.rowNameLine}>
                    <span style={styles.rowName}>{c.restaurantName}</span>
                    <span style={c.active ? styles.pillActive : styles.pillInactive}>
                      {c.active ? "Actif" : "Désactivé"}
                    </span>
                  </div>
                  <span style={styles.rowMeta}>
                    identifiant : {c.login} · voix : {c.voiceId || "défaut"} · créé le{" "}
                    {new Date(c.createdAt).toLocaleDateString("fr-FR")}
                  </span>
                </div>
                <div style={styles.rowActions}>
                  {resetTarget === c.id ? (
                    <>
                      <input
                        style={styles.smallInput}
                        placeholder="nouveau mot de passe"
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        minLength={6}
                      />
                      <button style={styles.smallButton} onClick={() => handleResetPassword(c.id)}>
                        Valider
                      </button>
                      <button
                        style={styles.smallButtonGhost}
                        onClick={() => {
                          setResetTarget(null);
                          setResetPassword("");
                        }}
                      >
                        Annuler
                      </button>
                    </>
                  ) : (
                    <>
                      <button style={styles.smallButtonGhost} onClick={() => handleToggleActive(c)}>
                        {c.active ? "Désactiver" : "Réactiver"}
                      </button>
                      <button
                        style={styles.smallButtonGhost}
                        onClick={() => {
                          setResetTarget(c.id);
                          setResetPassword("");
                        }}
                      >
                        Réinitialiser mdp
                      </button>
                      <button
                        style={styles.smallButtonDanger}
                        onClick={() => handleDelete(c.id, c.restaurantName)}
                      >
                        Supprimer
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
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
    maxWidth: 720,
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
  logoutButton: {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text-muted)",
    fontFamily: "var(--font-body)",
    fontSize: 14,
    padding: "10px 16px",
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
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontFamily: "var(--font-body)",
    fontSize: 13,
    color: "var(--text-muted)",
  },
  inline: {
    display: "flex",
    gap: 8,
  },
  input: {
    flex: 1,
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 15,
    padding: "10px 12px",
  },
  smallInput: {
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    padding: "6px 10px",
    width: 160,
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
  smallButton: {
    background: "var(--accent)",
    border: "none",
    borderRadius: 8,
    color: "#1c1b1a",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    fontWeight: 600,
    padding: "0 14px",
    cursor: "pointer",
    whiteSpace: "nowrap",
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
  success: {
    background: "var(--accent-dim)",
    border: "1px solid var(--accent)",
    borderRadius: 10,
    color: "var(--text)",
    fontSize: 14,
    padding: "12px 14px",
    margin: 0,
  },
  error: {
    color: "#d97757",
    fontSize: 14,
    margin: 0,
  },
  hint: {
    color: "var(--text-muted)",
    fontSize: 14,
    margin: 0,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "12px 14px",
    flexWrap: "wrap",
  },
  rowInfo: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  rowNameLine: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  rowName: {
    fontFamily: "var(--font-display)",
    fontSize: 16,
    color: "var(--text)",
  },
  pillActive: {
    fontFamily: "var(--font-body)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    color: "var(--success)",
    border: "1px solid var(--success)",
    borderRadius: 999,
    padding: "1px 8px",
  },
  pillInactive: {
    fontFamily: "var(--font-body)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    color: "#d97757",
    border: "1px solid #d97757",
    borderRadius: 999,
    padding: "1px 8px",
  },
  rowMeta: {
    fontFamily: "var(--font-body)",
    fontSize: 12,
    color: "var(--text-muted)",
  },
  rowActions: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  },
};

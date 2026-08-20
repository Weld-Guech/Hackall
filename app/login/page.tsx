"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("raison") === "desactive") {
      setError("Ce compte a été désactivé. Contacte ton agence.");
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erreur inconnue");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de la connexion");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main style={styles.main}>
      <form style={styles.card} onSubmit={handleSubmit}>
        <span style={styles.eyebrow}>APPELRESTO</span>
        <h1 style={styles.title}>Connexion</h1>

        <label style={styles.label}>
          Identifiant
          <input
            style={styles.input}
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoFocus
          />
        </label>

        <label style={styles.label}>
          Mot de passe
          <input
            style={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <p style={styles.error}>{error}</p>}

        <button style={styles.button} type="submit" disabled={isLoading}>
          {isLoading ? "Connexion…" : "Se connecter"}
        </button>
      </form>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100dvh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 32,
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
    margin: 0,
    color: "var(--text)",
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
    fontSize: 16,
    padding: "10px 12px",
  },
  error: {
    color: "#d97757",
    fontSize: 14,
    margin: 0,
  },
  button: {
    background: "var(--accent)",
    border: "none",
    borderRadius: 12,
    color: "#1c1b1a",
    fontFamily: "var(--font-display)",
    fontSize: 18,
    fontWeight: 600,
    padding: "14px 0",
    cursor: "pointer",
    marginTop: 8,
  },
};

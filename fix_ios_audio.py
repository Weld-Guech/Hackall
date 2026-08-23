#!/usr/bin/env python3
"""Fix iOS Safari audio playback."""

import sys

def main():
    try:
        with open("app/page.tsx", "r") as f:
            content = f.read()
    except FileNotFoundError:
        print("ERREUR: app/page.tsx non trouve. Es-tu dans ~/appelresto-pwa ?")
        sys.exit(1)

    with open("app/page.tsx.bak", "w") as f:
        f.write(content)
    print("[1/5] Backup: app/page.tsx.bak")

    # --- Diagnostic ---
    has_prefetched = "prefetchedRef" in content
    has_old_play = "audio.play().catch(() => {});" in content
    has_await_fetch = "await fetch(" in content
    print(f"[2/5] Diagnostic: prefetchedRef={has_prefetched}, old_play={has_old_play}, await_fetch={has_await_fetch}")

    # --- Cas 1: fichier avec prefetchedRef (le code 'new' deja injecte) ---
    if has_prefetched:
        print("[3/5] Mode: correction du code avec prefetchedRef")

        # Fix 1: enlever le await devant audio.play() dans le cas cachedUrl
        content = content.replace("await audio.play();", "audio.play().catch(() => {});")

        # Fix 2: ajouter playsInline si manquant
        if "playsInline" not in content:
            content = content.replace(
                'audioRef.current = new Audio("data:audio/wav;base64,',
                'audioRef.current = new Audio("data:audio/wav;base64,'
            )
            # On ajoute playsInline apres la creation
            content = content.replace(
                'audioRef.current = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==");',
                'audioRef.current = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==");\n    audioRef.current.playsInline = true;\n    audioRef.current.preload = "auto";'
            )

        # Fix 3: dans le cas "cache miss", apres audio.src = data.url, il faut rejouer
        # Mais iOS bloquera. On ajoute quand meme un play() pour desktop
        # et on laisse le catch
        if "audio.src = data.url;" in content and "audio.src = data.url;\n      await" not in content:
            # Si c'est juste audio.src = data.url; sans await apres, on ajoute le play
            content = content.replace(
                "audio.src = data.url;",
                "audio.src = data.url;\n      audio.play().catch(() => {});"
            )

        print("[4/5] Corrections appliquees (mode prefetchedRef)")

    # --- Cas 2: fichier original (ancien code) ---
    elif has_old_play and has_await_fetch:
        print("[3/5] Mode: remplacement complet du code original")

        # Remplacer la declaration audioRef
        content = content.replace(
            "const audioRef = useRef<HTMLAudioElement>(null!);",
            """const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTtsUrl, setCurrentTtsUrl] = useState<string | null>(null);"""
        )

        # Remplacer le useEffect d'init audio
        old_init = """  useEffect(() => {
    audioRef.current = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==");
  }, []);"""

        new_init = """  useEffect(() => {
    const unlock = async () => {
      if (!audioRef.current) {
        audioRef.current = new Audio();
        audioRef.current.playsInline = true;
        audioRef.current.preload = "auto";
      }
      try {
        audioRef.current.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==";
        await audioRef.current.play();
      } catch {}
    };
    document.addEventListener("touchstart", unlock, { once: true });
    document.addEventListener("click", unlock, { once: true });
    return () => {
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("click", unlock);
    };
  }, []);

  useEffect(() => {
    if (!canCall) {
      setCurrentTtsUrl(null);
      return;
    }
    const { text, cacheKey } = buildAnnoncement(numero, prenom, texteLibre);
    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, cacheKey }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.url) {
          setCurrentTtsUrl(data.url);
          if (audioRef.current) {
            audioRef.current.src = data.url;
            audioRef.current.load();
          }
        }
      })
      .catch(() => {});
  }, [numero, prenom, texteLibre, canCall]);"""

        if old_init in content:
            content = content.replace(old_init, new_init)
            print("  -> useEffect init remplace")
        else:
            print("  AVERTISSEMENT: useEffect init non trouve exactement")

        # Remplacer la fonction annonce
        old_annonce = """  async function annonce(text: string, cacheKey: string, label: string) {
    setError(null);
    setIsLoading(true);
      const audio = audioRef.current;
    audio.play().catch(() => {});
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, cacheKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erreur inconnue");
      audio.src = data.url;"""

        new_annonce = """  async function annonce(text: string, cacheKey: string, label: string) {
    setError(null);
    setIsLoading(true);
    if (!audioRef.current || !currentTtsUrl) {
      setError("Audio non pret, patientez...");
      setIsLoading(false);
      return;
    }
    audioRef.current.currentTime = 0;
    audioRef.current.play()
      .then(() => {
        setHistory((prev) => [
          {
            id: `${Date.now()}`,
            label,
            time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
            url: currentTtsUrl,
            text,
          },
          ...prev,
        ].slice(0, 12));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Echec de l'annonce");
      })
      .finally(() => {
        setIsLoading(false);
      });"""

        if old_annonce in content:
            content = content.replace(old_annonce, new_annonce)
            print("  -> fonction annonce() remplacee")
        else:
            print("  AVERTISSEMENT: fonction annonce() non trouvee exactement")

        print("[4/5] Remplacement complet effectue")

    else:
        print("[3/5] ERREUR: Impossible de determiner la structure actuelle du fichier.")
        print("     Le fichier a peut-etre deja ete modifie manuellement.")
        print("     Solution: envoie-moi les 80 premieres lignes de app/page.tsx")
        print("     avec: head -n 80 app/page.tsx")
        sys.exit(1)

    with open("app/page.tsx", "w") as f:
        f.write(content)

    print("[5/5] OK: app/page.tsx mis a jour !")
    print("\n=== PROCHAINES ETAPES ===")
    print("1. rm -rf .next")
    print("2. npm run build")
    print("3. Redemarrer le serveur")
    print("4. Sur iPad: vider le cache Safari")
    print("5. Recharger en mode prive d'abord")

if __name__ == "__main__":
    main()


"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Empêche l'écran de s'éteindre pendant que l'app tourne en mode
 * comptoir. Se ré-active automatiquement si l'onglet reprend le focus
 * (le Wake Lock est libéré par le navigateur quand l'onglet passe en
 * arrière-plan).
 */
export function useWakeLock() {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    if (!("wakeLock" in navigator)) {
      setSupported(false);
      return;
    }

    const requestLock = async () => {
      try {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        setActive(true);
        wakeLockRef.current.addEventListener("release", () => setActive(false));
      } catch {
        setActive(false);
      }
    };

    requestLock();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !wakeLockRef.current) {
        requestLock();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      wakeLockRef.current?.release().catch(() => {});
    };
  }, []);

  return { active, supported };
}

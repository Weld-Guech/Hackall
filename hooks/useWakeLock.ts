"use client";

import { useEffect, useRef, useState } from "react";
import { shouldReacquireWakeLock } from "@/lib/wakeLockPolicy";

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
        const sentinel = await navigator.wakeLock.request("screen");
        wakeLockRef.current = sentinel;
        setActive(true);
        sentinel.addEventListener("release", () => {
          setActive(false);
          if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
        });
      } catch {
        setActive(false);
      }
    };

    requestLock();

    const onVisibilityChange = () => {
      if (shouldReacquireWakeLock(document.visibilityState, wakeLockRef.current)) {
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

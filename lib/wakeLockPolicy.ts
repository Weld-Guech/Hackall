// Décide si le kiosque doit redemander un Screen Wake Lock.
// Le navigateur libère le verrou dès que l'onglet passe en arrière-plan
// (sentinel.released === true) : le sentinel existant n'est plus utilisable
// et il faut en demander un nouveau au retour au premier plan.

export function shouldReacquireWakeLock(
  visibilityState: string,
  sentinel: { released: boolean } | null
): boolean {
  return visibilityState === "visible" && (sentinel == null || sentinel.released);
}

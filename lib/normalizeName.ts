// Comparaison insensible aux accents/majuscules, partagée entre le kiosque
// (suggestions à la saisie) et le serveur (dédoublonnage des prénoms
// enregistrés automatiquement) pour qu'ils s'accordent sur ce qui compte
// comme "le même prénom".
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

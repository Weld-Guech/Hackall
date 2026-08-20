# AppelResto — starter PWA

Kiosque web pour annoncer les commandes prêtes en voix quasi-humaine (ElevenLabs),
pensé pour tourner sur n'importe quelle tablette/écran de comptoir, avec cache
automatique (un numéro ou un prénom n'est généré qu'une seule fois).

## Démarrage

```bash
npm install
cp .env.local.example .env.local
# édite .env.local avec ta clé ElevenLabs et l'ID de la voix choisie
npm run dev
```

Ouvre http://localhost:3000 sur l'écran du comptoir.

## Comptes clients (dashboard agence)

L'app est multi-tenant : chaque restaurant a son propre identifiant/mot de
passe, sa propre voix ElevenLabs (optionnelle) et son propre historique.

1. Va sur `/admin/login` et connecte-toi avec `ADMIN_PASSWORD` (défini dans
   `.env.local`).
2. Sur `/admin`, crée un accès : nom du restaurant, identifiant, mot de passe
   (bouton "Générer" pour un mot de passe aléatoire), Voice ID ElevenLabs
   optionnel. **Le mot de passe n'est affiché qu'une seule fois** à la
   création — transmets-le au client immédiatement.
3. Le client se connecte sur `/login` avec ces identifiants. Il arrive
   directement sur le kiosque (`/`) et peut ajuster son nom de restaurant et
   sa voix depuis `/parametres`.

Les comptes sont stockés dans `data/clients.json` (mots de passe hashés,
jamais en clair). Comme pour le cache audio, ce fichier vit sur le
filesystem : il persiste sur un serveur/VPS classique, mais **pas** sur une
plateforme serverless comme Vercel entre deux déploiements (voir la section
suivante).

## Où se trouve la clé API

**Nulle part côté client.** Elle vit uniquement dans `.env.local` (jamais commité,
voir `.gitignore`) et n'est lue que par `app/api/tts/route.ts`, qui tourne côté
serveur. Le navigateur ne voit jamais la clé, même en inspectant le code source.

## Architecture du cache

1. Le client appelle `POST /api/tts` avec le texte à prononcer.
2. La route vérifie si le fichier existe déjà dans `public/audio/generated/`.
   - Si oui → renvoie l'URL directement, **aucun crédit ElevenLabs consommé**.
   - Si non → génère via l'API ElevenLabs (modèle `eleven_flash_v2_5`), sauvegarde
     le fichier, puis renvoie l'URL.
3. Le service worker (`public/sw.js`) met aussi en cache ces fichiers côté
   navigateur, pour que l'écran continue de fonctionner même si le wifi du
   restaurant tombe (une fois les fichiers déjà générés au moins une fois).

## Mode kiosque

- `useWakeLock` (dans `hooks/`) empêche l'écran de se mettre en veille.
- Le manifest PWA (`public/manifest.json`) permet d'ajouter l'app à l'écran
  d'accueil en plein écran, sans barre d'adresse.
- Pense à activer "Accès guidé" (iPad) ou le mode kiosque équivalent sur
  Android/Chrome OS pour empêcher le personnel de sortir accidentellement
  de l'app.

## Prochaines étapes suggérées

- Remplacer le stockage filesystem (`data/clients.json` et le cache audio)
  par une base de données/stockage persistant (Postgres, Vercel Blob, S3...)
  si tu déploies sur une plateforme serverless comme Vercel — le filesystem
  d'une fonction serverless n'est pas garanti persistant entre deux
  déploiements.
- Ajouter une icône PWA réelle dans `public/icons/` (192×192 et 512×512).
- Support multi-admin (plusieurs agences/comptes agence) si un jour tu gères
  ce dashboard à plusieurs.

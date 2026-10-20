# Annonces vocales : cache audio partagé

## Principe

Une annonce est découpée en segments : `La commande` + `cent vingt-cinq` +
`est prête.` (groupe : `Les commandes` + X + pause + Y + `et` + Z +
`sont prêtes.`). Chaque segment est un MP3 servi par
`GET /api/tts?seg=…&ctx=fixe|id|libre&v=…`, mis en cache sur le disque du
VPS et **partagé entre tous les restaurants qui ont la même voix**.

- Le segment est déjà en cache : servi immédiatement, aucun crédit consommé.
- Il n'est pas en cache : appel à ElevenLabs (avec `previous_text` / `next_text`
  pour l'intonation), découpe des silences avec ffmpeg, enregistrement.
- ElevenLabs met plus de 2 s, renvoie une erreur ou n'a plus de quota : la
  phrase est lue par **Piper** (voix locale) et le segment est marqué
  *provisoire*. L'appel ElevenLabs continue en arrière-plan et remplace le
  provisoire s'il aboutit. Sinon, `npm run tts:regen` s'en charge.
- Les nouveaux prénoms sont notés dans
  `$TTS_CACHE_DIR/logs/nouveaux-prenoms.jsonl`, pour compléter
  `lib/phoneticCorrections.ts`.

Sur la tablette : le bouton **Démarrer le service** active le son (obligatoire
sur iOS). Si iOS coupe le son (veille, appel), un bandeau rouge
**Toucher pour réactiver le son** apparaît. Le service worker garde les
segments définitifs, ce qui permet d'annoncer même sans réseau.

## Mise en place sur le VPS (une fois)

Dans le dossier du projet sur le VPS, une commande par ligne :

```
sudo apt install -y ffmpeg
git pull
npm ci
npm run build
node scripts/tts-setup.mjs
pm2 reload appelresto --update-env
```

`tts-setup.mjs` complète `.env.local` (après une sauvegarde) et vérifie
ffmpeg, Piper, la voix et le dossier de cache. Tant qu'il affiche `!!`,
corrige le point signalé puis relance-le.

## Pré-génération

```
node scripts/tts-pregen.mjs --essai
node scripts/tts-pregen.mjs
```

Pour ajouter le top INSEE (un prénom par ligne, dans un fichier `.txt`
déposé dans le dossier du projet) :

```
node scripts/tts-pregen.mjs --prenoms top-insee.txt --essai
node scripts/tts-pregen.mjs --prenoms top-insee.txt
```

Le script peut être interrompu (Ctrl+C) et relancé à tout moment : ce qui est
déjà en cache est sauté gratuitement. Options : `--avec-prenoms-arabes`,
`--sans-numeros`, `--concurrence 2`, `--pause 400`, `--voix <id>`.

Pour un long traitement, lance-le dans `screen` afin qu'il survive à la
déconnexion SSH : `screen -S pregen`, lance la commande, puis `Ctrl+A` et
`D` pour détacher. `screen -r pregen` pour y revenir.

## Entretien

| Besoin | Commande |
|---|---|
| Remplacer les voix Piper provisoires | `node scripts/tts-regen-provisoire.mjs` |
| Voir les nouveaux prénoms | `tail -n 50 /home/ubuntu/hackall-tts-cache/logs/nouveaux-prenoms.jsonl` |
| Compter les provisoires | `ls /home/ubuntu/hackall-tts-cache/provisoire/*.mp3 \| wc -l` |
| Taille du cache | `du -sh /home/ubuntu/hackall-tts-cache` |
| Logs TTS en direct | `pm2 logs appelresto \| grep tts` |

Après avoir corrigé un prénom dans `lib/phoneticCorrections.ts` : commit,
push, `git pull`, build, reload. Seul ce prénom est régénéré, au prochain
appel (ou avec `tts-pregen.mjs`).

## Réglages (`.env.local`)

| Variable | Rôle |
|---|---|
| `TTS_CACHE_DIR` | dossier du cache (hors du build) |
| `TTS_MODEL_ID` | `eleven_multilingual_v2` ou `eleven_flash_v2_5` (moitié moins cher) |
| `ELEVENLABS_TIMEOUT_MS` | délai avant le secours Piper (2000) |
| `PIPER_BIN`, `PIPER_MODEL` | Piper et sa voix |
| `TTS_INTERNAL_TOKEN` | secret des scripts (généré par `tts-setup.mjs`) |

Changer `TTS_MODEL_ID` ou la voix crée un nouveau cache, qui se remplit au fil des
appels ou avec `tts-pregen.mjs`. Ensuite, incrémente `TTS_PIPELINE_VERSION`
dans `lib/tts/text.ts`, pour que les tablettes ne rejouent pas l'ancienne
voix depuis leur cache.

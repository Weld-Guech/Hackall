// Lecteur Web Audio des annonces découpées en segments.
//
// - Un AudioContext unique, débloqué par le bouton "Démarrer le service"
//   (iOS n'autorise le son qu'après un geste utilisateur).
// - Chaque segment est téléchargé, décodé puis rogné de son silence
//   résiduel (le décodeur MP3 de Safari ajoute quelques ms en tête).
// - Les segments sont programmés à l'échantillon près sur l'horloge du
//   contexte, avec un fondu croisé de 15 ms aux jonctions : pas de blanc,
//   pas de clic.
import type { Part } from "../tts/segments.ts";
import { playbackGuardMs } from "../audioPlayback.ts";

export type LoadedSegment = { buffer: AudioBuffer; final: boolean };
export type LoadedPart = LoadedSegment | { pause: number };

const FADE_S = 0.015;
const START_DELAY_S = 0.03;
const SILENCE_THRESHOLD = 0.003;
const TRIM_MARGIN_S = 0.008;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };
type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

function decode(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  // Copie avant décodage : decodeAudioData détache (neuter) l'ArrayBuffer.
  // Vieux Safari : pas de promesse, seulement les callbacks.
  const p = ctx.decodeAudioData(data.slice(0));
  if (p && typeof p.then === "function") return p;
  return new Promise<AudioBuffer>((resolve, reject) => {
    ctx.decodeAudioData(data.slice(0), resolve, reject);
  });
}

// Retire le silence de début/fin laissé par l'encodeur et le décodeur MP3,
// en gardant une petite marge pour ne pas couper l'attaque.
function trimSilence(ctx: AudioContext, buf: AudioBuffer): AudioBuffer {
  const data = buf.getChannelData(0);
  let first = 0;
  while (first < data.length && Math.abs(data[first]) < SILENCE_THRESHOLD) first++;
  let last = data.length - 1;
  while (last > first && Math.abs(data[last]) < SILENCE_THRESHOLD) last--;
  if (first >= last) return buf;

  const margin = Math.round(TRIM_MARGIN_S * buf.sampleRate);
  const start = Math.max(0, first - margin);
  const end = Math.min(data.length, last + 1 + margin);
  if (start === 0 && end === data.length) return buf;

  const out = ctx.createBuffer(buf.numberOfChannels, end - start, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.getChannelData(c).set(buf.getChannelData(c).subarray(start, end));
  }
  return out;
}

export class SegmentPlayer {
  readonly ctx: AudioContext;
  private segments = new Map<string, Promise<LoadedSegment>>();
  private sources = new Set<AudioBufferSourceNode>();

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  static create(): SegmentPlayer | null {
    if (typeof window === "undefined") return null;
    const Ctor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return null;
    // iPhone : sans ce réglage (Safari 17+), la Web Audio API est muette
    // quand le bouton silencieux est activé.
    try {
      const nav = navigator as AudioSessionNavigator;
      if (nav.audioSession) nav.audioSession.type = "playback";
    } catch {
      // API absente : sans importance
    }
    return new SegmentPlayer(new Ctor());
  }

  get running(): boolean {
    return this.ctx.state === "running";
  }

  // À appeler pendant un geste utilisateur : resume() puis lecture d'un
  // buffer silencieux, c'est ce qui "arme" durablement la sortie sur iOS.
  // iOS peut aussi laisser le contexte dans l'état non standard
  // "interrupted" (appel, veille) : on le traite comme "suspended".
  async unlock(): Promise<boolean> {
    try {
      if (this.ctx.state !== "running") await this.ctx.resume();
    } catch {
      // on tente quand même le buffer silencieux
    }
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, 22050);
      src.connect(this.ctx.destination);
      src.start(0);
    } catch {
      // sans importance
    }
    return this.running;
  }

  // Les segments définitifs restent en mémoire ; un segment provisoire
  // (Piper) est redemandé la fois suivante, au cas où la vraie voix serait
  // arrivée entre-temps.
  load(url: string): Promise<LoadedSegment> {
    const existing = this.segments.get(url);
    if (existing) return existing;
    const job = (async () => {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Erreur audio (${res.status})`);
      }
      const final = res.headers.get("X-TTS-Final") === "1";
      const buffer = trimSilence(this.ctx, await decode(this.ctx, await res.arrayBuffer()));
      return { buffer, final };
    })();
    this.segments.set(url, job);
    job.then(
      (s) => {
        if (!s.final) this.segments.delete(url);
      },
      () => this.segments.delete(url)
    );
    return job;
  }

  loadAll(parts: Part[]): Promise<LoadedPart[]> {
    return Promise.all(parts.map((p) => ("url" in p ? this.load(p.url) : Promise.resolve(p))));
  }

  // Programme toute la séquence d'un coup sur l'horloge audio et se résout
  // à la fin. Plafonné par playbackGuardMs : si iOS suspend le contexte en
  // pleine lecture, la file d'annonces ne reste pas bloquée.
  play(parts: LoadedPart[]): Promise<void> {
    const ctx = this.ctx;
    let t = ctx.currentTime + START_DELAY_S;
    const startedAt = t;
    let end = t;
    const mine: AudioBufferSourceNode[] = [];

    for (const p of parts) {
      if ("pause" in p) {
        t = end + p.pause / 1000;
        continue;
      }
      const dur = p.buffer.duration;
      const fade = Math.min(FADE_S, dur / 3);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(1, t + fade);
      gain.gain.setValueAtTime(1, t + dur - fade);
      gain.gain.linearRampToValueAtTime(0, t + dur);
      gain.connect(ctx.destination);

      const src = ctx.createBufferSource();
      src.buffer = p.buffer;
      src.connect(gain);
      src.onended = () => {
        this.sources.delete(src);
        try {
          gain.disconnect();
        } catch {
          // déjà déconnecté
        }
      };
      src.start(t);
      this.sources.add(src);
      mine.push(src);

      end = t + dur;
      // Le segment suivant démarre pendant le fondu de sortie : fondu croisé.
      t = end - fade;
    }

    const totalS = end - startedAt;
    return new Promise((resolve) => {
      if (mine.length === 0) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      const guard = window.setTimeout(() => {
        mine.forEach((s) => this.stopSource(s));
        finish();
      }, playbackGuardMs(totalS + START_DELAY_S));
      mine[mine.length - 1].addEventListener("ended", finish);
    });
  }

  private stopSource(src: AudioBufferSourceNode) {
    try {
      src.stop();
    } catch {
      // déjà arrêtée
    }
    this.sources.delete(src);
  }

  stopAll() {
    Array.from(this.sources).forEach((s) => this.stopSource(s));
  }
}

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { hashPassword, verifyPassword } from "./password";

// Stockage fichier volontairement simple (pas de base de données dans ce
// projet). Sur un serveur/VPS classique, data/clients.json persiste entre
// les redémarrages. Sur une plateforme serverless (Vercel...), le filesystem
// n'est pas garanti de survivre entre deux déploiements — voir README.
const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "clients.json");
const MAX_ROUTINES = 12;

export type Routine = {
  id: string;
  label: string;
  text: string;
};

export type Client = {
  id: string;
  login: string;
  passwordHash: string;
  restaurantName: string;
  voiceId: string;
  active: boolean;
  routines: Routine[];
  createdAt: string;
};

export type PublicClient = Omit<Client, "passwordHash">;

function readAll(): Client[] {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as (Omit<
      Client,
      "active" | "routines"
    > & {
      active?: boolean;
      routines?: Routine[];
    })[];
    // Comptes créés avant l'ajout des champs `active`/`routines` : valeurs par défaut.
    return raw.map((c) => ({ ...c, active: c.active ?? true, routines: c.routines ?? [] }));
  } catch {
    return [];
  }
}

function writeAll(clients: Client[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(clients, null, 2));
}

function toPublic(c: Client): PublicClient {
  const { passwordHash: _passwordHash, ...rest } = c;
  return rest;
}

export function listClients(): PublicClient[] {
  return readAll()
    .map(toPublic)
    .sort((a, b) => a.restaurantName.localeCompare(b.restaurantName, "fr"));
}

export function getClientById(id: string): Client | undefined {
  return readAll().find((c) => c.id === id);
}

export function findByLogin(login: string): Client | undefined {
  const norm = login.trim().toLowerCase();
  return readAll().find((c) => c.login.toLowerCase() === norm);
}

export function createClient(input: {
  login: string;
  password: string;
  restaurantName: string;
  voiceId: string;
}): PublicClient {
  const clients = readAll();
  const login = input.login.trim();
  if (!login) throw new Error("Identifiant requis");
  if (clients.some((c) => c.login.toLowerCase() === login.toLowerCase())) {
    throw new Error("Cet identifiant existe déjà");
  }

  const client: Client = {
    id: crypto.randomUUID(),
    login,
    passwordHash: hashPassword(input.password),
    restaurantName: input.restaurantName.trim(),
    voiceId: input.voiceId.trim(),
    active: true,
    routines: [],
    createdAt: new Date().toISOString(),
  };
  clients.push(client);
  writeAll(clients);
  return toPublic(client);
}

export function deleteClient(id: string): boolean {
  const clients = readAll();
  const next = clients.filter((c) => c.id !== id);
  if (next.length === clients.length) return false;
  writeAll(next);
  return true;
}

export function updateClient(
  id: string,
  patch: Partial<Pick<Client, "restaurantName" | "voiceId">>
): PublicClient | undefined {
  const clients = readAll();
  const client = clients.find((c) => c.id === id);
  if (!client) return undefined;
  if (patch.restaurantName !== undefined) client.restaurantName = patch.restaurantName.trim();
  if (patch.voiceId !== undefined) client.voiceId = patch.voiceId.trim();
  writeAll(clients);
  return toPublic(client);
}

export function setClientPassword(id: string, password: string): boolean {
  const clients = readAll();
  const client = clients.find((c) => c.id === id);
  if (!client) return false;
  client.passwordHash = hashPassword(password);
  writeAll(clients);
  return true;
}

export function setClientActive(id: string, active: boolean): boolean {
  const clients = readAll();
  const client = clients.find((c) => c.id === id);
  if (!client) return false;
  client.active = active;
  writeAll(clients);
  return true;
}

export function verifyLogin(login: string, password: string): Client | null {
  const client = findByLogin(login);
  if (!client) return null;
  return verifyPassword(password, client.passwordHash) ? client : null;
}

export function addRoutine(
  clientId: string,
  input: { label: string; text: string }
): Routine | { error: string } {
  const label = input.label.trim();
  const text = input.text.trim();
  if (!label || !text) return { error: "Titre et phrase requis" };

  const clients = readAll();
  const client = clients.find((c) => c.id === clientId);
  if (!client) return { error: "Compte introuvable" };
  if (client.routines.length >= MAX_ROUTINES) {
    return { error: `Limite de ${MAX_ROUTINES} routines atteinte` };
  }

  const routine: Routine = { id: crypto.randomUUID(), label, text };
  client.routines.push(routine);
  writeAll(clients);
  return routine;
}

export function updateRoutine(
  clientId: string,
  routineId: string,
  patch: Partial<Pick<Routine, "label" | "text">>
): Routine | undefined {
  const clients = readAll();
  const client = clients.find((c) => c.id === clientId);
  const routine = client?.routines.find((r) => r.id === routineId);
  if (!client || !routine) return undefined;
  if (patch.label !== undefined && patch.label.trim()) routine.label = patch.label.trim();
  if (patch.text !== undefined && patch.text.trim()) routine.text = patch.text.trim();
  writeAll(clients);
  return routine;
}

export function deleteRoutine(clientId: string, routineId: string): boolean {
  const clients = readAll();
  const client = clients.find((c) => c.id === clientId);
  if (!client) return false;
  const next = client.routines.filter((r) => r.id !== routineId);
  if (next.length === client.routines.length) return false;
  client.routines = next;
  writeAll(clients);
  return true;
}

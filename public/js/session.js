// Anmeldung für die ganze App – Planer und Video-Bereiche teilen sich diesen Stand.
//
//   Rolle null     ansehen und Training (ohne Anmeldung)
//   Rolle "group"  Gruppen-Code: zusätzlich Videos hochladen
//   Rolle "tagger" Trainer-Code: zusätzlich Choreos bearbeiten
//
// Der Server merkt sich die Anmeldung als HttpOnly-Cookie (/api/session). Hier
// liegt nur die zuletzt bekannte Rolle – damit die App auch offline startet,
// wie sie zuletzt war. Entscheiden tut immer der Server.
//
// Jede Änderung feuert window "sessionchange" (detail: { role }).

const ROLE_KEY = "formation.role";
const NAME_KEY = "formation.name";
const OLD_NAME_KEYS = ["choreo_user_name", "portal.name"]; // Planer bzw. Video-Seiten, früher getrennt
const OLD_CODE_KEY = "portal.code"; // noch früher lag der Code selbst im Browser

// localStorage kann in privaten Fenstern fehlen oder werfen – dann eben ohne Merken.
function load(key) {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* egal */ }
}
function forget(key) {
  try { localStorage.removeItem(key); } catch { /* egal */ }
}

export class SessionError extends Error {
  /** status 401 = Code falsch, ohne Status = keine Verbindung */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let role = null;
let restoring = null;

function setRole(next) {
  role = next || null;
  save(ROLE_KEY, role || "");
}

function emit() {
  window.dispatchEvent(new CustomEvent("sessionchange", { detail: { role } }));
}

async function post(code) {
  let res;
  try {
    res = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new SessionError("Keine Verbindung – bitte später noch einmal.");
  }
  if (res.status === 401) throw new SessionError("Der Code stimmt nicht.", 401);
  if (!res.ok) throw new SessionError(`Server-Fehler (${res.status})`, res.status);
  return (await res.json()).role;
}

async function check() {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let { role: current } = await res.json();
    if (!current) {
      // Einmaliger Umzug: früher gespeicherten Code gegen ein Cookie tauschen
      const old = load(OLD_CODE_KEY);
      forget(OLD_CODE_KEY);
      if (old) current = await post(old).catch(() => null);
    }
    setRole(current);
  } catch {
    role = load(ROLE_KEY) || null; // offline: wie zuletzt
  }
  return role;
}

export const session = {
  get role() { return role; },
  get canUpload() { return role === "group" || role === "tagger"; },
  get isTrainer() { return role === "tagger"; },

  /** Stand beim Server erfragen – nur einmal pro Start, alle warten auf dasselbe. */
  restore() {
    restoring ??= check();
    return restoring;
  },

  /** Code prüfen und Anmeldung merken; wirft SessionError. Gibt die Rolle zurück. */
  async login(code) {
    setRole(await post(code));
    emit();
    return role;
  },

  async logout() {
    await fetch("/api/session", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
    setRole(null);
    emit();
  },

  /** Name für „wer hat hochgeladen“ und „wer bearbeitet gerade“. */
  getName() {
    const name = load(NAME_KEY);
    if (name) return name;
    for (const key of OLD_NAME_KEYS) {
      const old = load(key);
      if (old) { save(NAME_KEY, old); return old; }
    }
    return "";
  },
  setName(name) { save(NAME_KEY, (name || "").trim()); },
};

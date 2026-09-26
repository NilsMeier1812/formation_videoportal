// Anmeldung – gilt für die ganze App (Stand und Server-Aufrufe in /js/session.js).
// Ansehen und Training gehen ohne Anmeldung; Bearbeiten nur mit Trainer-Code.
// Der Server merkt sich die Anmeldung per Cookie ein Jahr lang.
import { session } from "/js/session.js";

const ROLE_LABELS = { tagger: "Trainer", group: "Gruppe" };
const ROLE_HINTS = {
  tagger: "Alles, auch bearbeiten und zuordnen",
  group: "Ansehen, Training und Videos hochladen",
};

export function auth() {
  return {
    role: null, // null | 'group' | 'tagger'
    isEditor: false, // darf bearbeiten (Trainer-Code)
    authChecked: false, // erst danach entscheidet sich, ob der Anmeldebildschirm kommt
    loginOpen: false,
    loginPassword: "",
    loginName: "",
    loginError: "",
    loggingIn: false,
    showPw: false,

    get roleLabel() {
      const label = ROLE_LABELS[this.role];
      if (!label) return "Nicht angemeldet";
      return this.userName ? `${label} · ${this.userName}` : label;
    },
    get roleHint() { return ROLE_HINTS[this.role] || ""; },

    async initAuth() {
      this.applyRole(await session.restore());
      this.authChecked = true;
      // Anmeldung kann sich auch in einem anderen Bereich ändern (z. B. beim Hochladen)
      window.addEventListener("sessionchange", (e) => this.applyRole(e.detail.role));
    },

    /** Die App ist privat: Daten gibt es erst nach der Anmeldung (Anmeldebildschirm). */
    waitForLogin() {
      if (this.role) return Promise.resolve();
      return new Promise((resolve) => {
        const onChange = (e) => {
          if (!e.detail.role) return;
          window.removeEventListener("sessionchange", onChange);
          resolve();
        };
        window.addEventListener("sessionchange", onChange);
      });
    },

    applyRole(role) {
      const wasEditor = this.isEditor;
      this.role = role;
      this.isEditor = role === "tagger";
      if (wasEditor === this.isEditor) return;
      if (!this.isEditor && this.currentMode === "editor") this.exitEditor();
      // Private Projekte schickt der Server nur Trainern → Liste neu holen
      if (this.projects.length) this.loadProjects();
    },

    openLogin() {
      this.loginError = "";
      this.loginPassword = "";
      this.loginName = this.userName || "";
      this.showPw = false;
      this.loginOpen = true; // liegt über dem Menü – danach ist man wieder im Menü
    },
    closeLogin() { this.loginOpen = false; },

    async doLogin() {
      const code = this.loginPassword;
      if (!code || this.loggingIn) return;
      this.loggingIn = true;
      this.loginError = "";
      try {
        // Name ist optional; leer = Anzeige „wer bearbeitet“ bleibt leer.
        // Vor dem Anmelden merken – die anderen Bereiche lesen ihn beim Ereignis „sessionchange“.
        const name = (this.loginName || "").trim();
        if (name || !session.getName()) session.setName(name);
        const role = await session.login(code);
        this.userName = session.getName();
        this.loginPassword = "";
        this.loginName = "";
        this.loginOpen = false;
        // Angemeldet heißt nur: darf bearbeiten. Einschalten tut man es selbst.
        this.setStatus(role === "tagger" ? "Angemeldet als Trainer" : "Angemeldet mit Gruppen-Code");
      } catch (e) {
        this.loginError = e.status === 401
          ? "Code falsch. Bitte erneut versuchen."
          : e.message;
      } finally {
        this.loggingIn = false;
      }
    },

    async logout() {
      // Erst die Sperre freigeben – dafür braucht es die Anmeldung noch
      if (this.currentMode === "editor") await this.exitEditor();
      this.menuOpen = false; // danach kommt der Anmeldebildschirm
      await session.logout();
    },
  };
}

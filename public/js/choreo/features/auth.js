// Editor-Login: Bearbeiten nur mit Trainer-Code, Lesen/Training für alle.
// Der Server merkt sich die Anmeldung per Cookie ein Jahr lang.
import { remote } from "../data/index.js";

export function auth() {
  return {
    isEditor: false,
    loginOpen: false,
    loginPassword: "",
    loginName: "",
    loginError: "",
    loggingIn: false,
    showPw: false,

    async initAuth() {
      this.isEditor = await remote.restoreSession();
      remote.onAuthChange((isEditor) => { this.isEditor = isEditor; });
    },

    openLogin() {
      this.loginError = "";
      this.loginPassword = "";
      this.loginName = this.userName || "";
      this.showPw = false;
      this.loginOpen = true;
    },
    closeLogin() { this.loginOpen = false; },

    async doLogin() {
      const password = this.loginPassword;
      if (!password || this.loggingIn) return;
      this.loggingIn = true;
      this.loginError = "";
      try {
        await remote.login(password);
        this.isEditor = true;
        // Name ist optional; leer = Anzeige „wer bearbeitet“ bleibt leer
        this.userName = (this.loginName || "").trim();
        localStorage.setItem("choreo_user_name", this.userName);
        this.loginPassword = "";
        this.loginName = "";
        this.loginOpen = false;
        // Angemeldet heißt nur: darf bearbeiten. Den Modus wählt man selbst.
        this.setStatus("Angemeldet – zum Bearbeiten „Editor“ wählen");
      } catch (e) {
        this.loginError = e.code === "group"
          ? e.message
          : "Code falsch (oder offline). Bitte erneut versuchen.";
      } finally {
        this.loggingIn = false;
      }
    },

    async logout() {
      if (this.currentMode === "editor") await this.exitEditor();
      await remote.logout();
      this.isEditor = false;
      this.setStatus("Abgemeldet – nur noch Lesen/Training");
    },
  };
}

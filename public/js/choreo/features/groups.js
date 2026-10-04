// Paare, Abschnitte mit Gruppen und die Zuteilung „welches Paar ist in welcher Gruppe".
import { repo } from "../data/index.js";
import { round3, uuid } from "../lib/util.js";
import { rt } from "../runtime.js";

export const GROUP_MAX = 8;

export function groups() {
  return {
    GROUP_MAX,
    stepsView: "steps", // Unter-Reiter im Bearbeiten: steps | groups | pairs
    openPartId: null, // aufgeklappter Gruppen-Abschnitt

    // ---------------- Paare ----------------
    async loadPersons(projectId) {
      this.persons = await repo.loadRows("persons", projectId, "number");
    },
    addPerson() {
      if (!this.project) return;
      const number = this.persons.reduce((max, p) => Math.max(max, Number(p.number)), 0) + 1;
      const row = { id: uuid(), project_id: this.project.id, number, name: "" };
      this.persons.push(row);
      repo.insert("persons", row);
      this.autoPickPair();
    },
    renamePerson(person, name) {
      person.name = name;
      repo.patch("persons", person, { name });
    },
    removePerson(person) {
      if (!confirm(`Paar ${person.number}${person.name ? " (" + person.name + ")" : ""} löschen?`)) return;
      this.persons = this.persons.filter((x) => x.id !== person.id);
      this.memberships = this.memberships.filter((m) => Number(m.person_number) !== Number(person.number));
      repo.remove("persons", person, { offlineMessage: "Offline – gespeichert, wird synchronisiert" });
      if (Number(this.myPersonNumber) === Number(person.number)) this.setMyPerson(0);
      this.autoPickPair();
    },
    /**
     * Ohne gewähltes Paar zeigen die Spuren nur den Hinweis „hier klicken“ – außer es gibt
     * gar keine Paare (dann gelten alle Schritte für alle) oder es wird gerade bearbeitet.
     */
    get needsPairChoice() {
      return !this.isEditingSteps && !this.myPersonNumber && this.persons.length > 0;
    },
    /** Paar-Wahl öffnen: Reiter „Schritte & Gruppen“, Auswahl aufklappen (wo der Browser es erlaubt). */
    openPairChoice() {
      this.setTab("steps");
      if (this.currentMode === "editor") return; // im Bearbeiten sieht man ohnehin alle Schritte
      this.$nextTick(() => {
        const select = document.querySelector(".pair-select");
        if (!select) return;
        select.scrollIntoView({ block: "nearest" });
        select.focus();
        try { select.showPicker?.(); } catch { /* manche Browser lassen das nicht zu – dann bleibt der Fokus */ }
        select.classList.add("attention");
        setTimeout(() => select.classList.remove("attention"), 1600);
      });
    },
    /** Gibt es genau ein Paar, ist es automatisch gewählt; ein gelöschtes Paar ist nicht mehr gewählt. */
    autoPickPair() {
      const numbers = this.persons.map((p) => Number(p.number));
      if (this.myPersonNumber && !numbers.includes(Number(this.myPersonNumber))) this.setMyPerson(0);
      if (!this.myPersonNumber && numbers.length === 1) this.setMyPerson(numbers[0]);
    },
    /** „Ich bin Paar X" – merkt sich die Wahl pro Projekt. */
    setMyPerson(n) {
      this.myPersonNumber = Number(n) || 0;
      if (this.project) localStorage.setItem("choreo_person_" + this.project.id, this.myPersonNumber);
      this.scheduleDraw();
    },

    // ---------------- Abschnitte ----------------
    async loadParts(projectId) {
      this.parts = await repo.loadRows("parts", projectId, "start_sec");
      this.memberships = await repo.loadMemberships(this.parts.map((p) => p.id));
    },
    /**
     * Gruppen-Abschnitt ab der Abspielposition – bis zum nächsten Abschnitt (höchstens 8 s).
     * Liegt die Position schon in einem, wird der aufgeklappt.
     */
    addPartHere() {
      if (!this.project) return;
      const t = rt.ws ? round3(rt.ws.getCurrentTime()) : 0;
      const inside = this.partAt(t);
      if (inside) { this.openPartId = inside.id; this.setStatus("Hier gibt es schon einen Gruppen-Abschnitt"); return; }
      const next = this.sortedParts.find((p) => Number(p.start_sec) > t);
      const end = round3(Math.min(next ? Number(next.start_sec) : Infinity, t + 8, this.duration || Infinity));
      const row = {
        id: uuid(), project_id: this.project.id, sort_index: this.parts.length,
        label: "Abschnitt " + (this.parts.length + 1),
        start_sec: t, end_sec: end > t ? end : null, group_names: { 1: "", 2: "" },
      };
      this.parts.push(row);
      repo.insert("parts", row);
      this.openPartId = row.id;
      this.scheduleDraw();
    },
    togglePart(part) {
      this.openPartId = this.openPartId === part.id ? null : part.id;
      if (this.openPartId) this.seekTo(Number(part.start_sec) || 0);
    },
    partRange(part) {
      const end = part.end_sec == null ? "Schluss" : this.fmt(part.end_sec).slice(0, -3);
      return `${this.fmt(part.start_sec).slice(0, -3)}–${end}`;
    },
    partSummary(part) {
      const nums = this.groupNumbersOf(part);
      if (!nums.length) return "noch keine Gruppen";
      const assigned = this.memberships.filter((m) => m.part_id === part.id && Number(m.group_number)).length;
      return nums.map((n) => this.groupNameOf(part, n)).join(" · ") + ` · ${assigned}/${this.persons.length} zugeteilt`;
    },
    /** Zeitstrahl der Gruppen-Abschnitte (Lücken = alle gleich). */
    get partBlocks() {
      const dur = this.duration || 0;
      if (!dur) return [];
      return this.sortedParts.map((p) => {
        const start = Math.max(0, Number(p.start_sec) || 0);
        const end = Math.min(dur, p.end_sec == null ? dur : Number(p.end_sec));
        return { p, left: (start / dur) * 100, width: Math.max(0.6, ((end - start) / dur) * 100) };
      });
    },
    patchPart(part, changes) {
      Object.assign(part, changes);
      repo.patch("parts", part, changes);
    },
    setPartBound(part, field, value) {
      if (field === "end_sec" && (value === "" || value == null)) {
        this.patchPart(part, { end_sec: null });
        return;
      }
      const n = parseFloat(value);
      if (!isNaN(n)) this.patchPart(part, { [field]: Math.max(0, round3(n)) });
    },
    partBoundToCursor(part, field) {
      this.patchPart(part, { [field]: rt.ws ? round3(rt.ws.getCurrentTime()) : 0 });
    },
    removePart(part) {
      if (!confirm(`Gruppen-Abschnitt „${part.label || "Abschnitt"}“ löschen? Die Zuteilungen gehen verloren.`)) return;
      if (this.openPartId === part.id) this.openPartId = null;
      this.parts = this.parts.filter((x) => x.id !== part.id);
      this.memberships = this.memberships.filter((m) => m.part_id !== part.id); // DB: ON DELETE CASCADE
      repo.remove("parts", part, { offlineMessage: "Offline – gespeichert, wird synchronisiert" });
    },

    // ---------------- Gruppen eines Abschnitts ----------------
    setGroupNames(part, names) { this.patchPart(part, { group_names: names }); },
    addGroup(part) {
      const nums = this.groupNumbersOf(part);
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      this.setGroupNames(part, { ...(part.group_names || {}), [next]: "" });
    },
    renameGroup(part, n, name) {
      this.setGroupNames(part, { ...(part.group_names || {}), [n]: name });
      this.scheduleDraw();
    },
    removeGroup(part, n) {
      const names = { ...(part.group_names || {}) };
      delete names[n];
      this.setGroupNames(part, names);
      const affected = this.memberships.filter((m) => m.part_id === part.id && Number(m.group_number) === Number(n));
      for (const m of affected) this.setMembership(part, m.person_number, 0);
    },

    // ---------------- Zuteilung ----------------
    /** Tipp auf das Paar schaltet durch: alle → definierte Gruppen → alle. */
    cycleGroup(part, personNumber) {
      const seq = [0, ...this.groupNumbersOf(part)];
      if (seq.length <= 1) { this.setStatus("Erst Gruppe(n) anlegen"); return; }
      const idx = Math.max(0, seq.indexOf(this.groupOf(part, personNumber)));
      this.setMembership(part, personNumber, seq[(idx + 1) % seq.length]);
    },
    setMembership(part, personNumber, groupNumber) {
      const existing = this.memberships.find(
        (x) => x.part_id === part.id && Number(x.person_number) === Number(personNumber)
      );
      if (groupNumber === 0) {
        if (existing) {
          this.memberships = this.memberships.filter((x) => x.id !== existing.id);
          repo.remove("group_memberships", existing, { offlineMessage: "Offline – gespeichert, wird synchronisiert" });
        }
      } else if (existing) {
        existing.group_number = groupNumber;
        repo.patch("group_memberships", existing, { group_number: groupNumber });
      } else {
        const row = { id: uuid(), part_id: part.id, person_number: Number(personNumber), group_number: groupNumber };
        this.memberships.push(row);
        repo.insert("group_memberships", row);
      }
      this.scheduleDraw();
    },
  };
}

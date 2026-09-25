// Paare, Abschnitte mit Gruppen und die Zuteilung „welches Paar ist in welcher Gruppe".
import { repo } from "../data/index.js";
import { round3, uuid } from "../lib/util.js";
import { rt } from "../runtime.js";

export const GROUP_MAX = 8;

export function groups() {
  return {
    GROUP_MAX,

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
    addPart() {
      if (!this.project) return;
      const list = this.sortedParts;
      const last = list[list.length - 1];
      let start = 0;
      if (last) {
        start = last.end_sec == null
          ? Math.min(this.duration || 0, (Number(last.start_sec) || 0) + 1)
          : Number(last.end_sec);
      }
      if (last && last.end_sec == null) this.patchPart(last, { end_sec: round3(start) });
      const row = {
        id: uuid(), project_id: this.project.id, sort_index: this.parts.length,
        label: "Abschnitt " + (this.parts.length + 1),
        start_sec: round3(start), end_sec: null,
      };
      this.parts.push(row);
      repo.insert("parts", row);
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
      if (!confirm(`„${part.label || "Abschnitt"}“ löschen?`)) return;
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

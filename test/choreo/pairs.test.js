import { describe, expect, it } from "vitest";
import { pairForName } from "../../public/js/choreo/lib/pairs.js";

const persons = [
  { number: 1, name: "Anna & Ben" },
  { number: 2, name: "Clara und David" },
  { number: 3, name: "Émilie Müller, Jörg Schulz" },
  { number: 4, name: "" },
  { number: 5, name: "Lena/Max" },
  { number: 7, name: "Sophie Weber | Tim Koch" },
  { number: 8, name: "Mia|Noah" },
];

describe("Paar zum Namen", () => {
  it("findet das Paar über den Vornamen", () => {
    expect(pairForName(persons, "Ben")).toBe(1);
    expect(pairForName(persons, "anna")).toBe(1);
    expect(pairForName(persons, " David ")).toBe(2);
    expect(pairForName(persons, "Max")).toBe(5);
  });
  it("Trennstrich „Name1 | Name2“", () => {
    expect(pairForName(persons, "Tim")).toBe(7);
    expect(pairForName(persons, "sophie weber")).toBe(7);
    expect(pairForName(persons, "Noah")).toBe(8);
    expect(pairForName(persons, "Mia")).toBe(8);
  });
  it("Akzente, Umlaute, Nachname egal", () => {
    expect(pairForName(persons, "Emilie")).toBe(3);
    expect(pairForName(persons, "joerg")).toBe(0); // oe ≠ ö – kein Raten
    expect(pairForName(persons, "Jörg")).toBe(3);
    expect(pairForName(persons, "Jörg Schulz")).toBe(3);
    expect(pairForName(persons, "Ben Meier")).toBe(1); // Vorname reicht
  });
  it("kein Treffer oder mehrdeutig → nichts wählen", () => {
    expect(pairForName(persons, "")).toBe(0);
    expect(pairForName(persons, "Zoe")).toBe(0);
    expect(pairForName(persons, "An")).toBe(0); // nur ganze Wörter
    expect(pairForName([...persons, { number: 6, name: "Anna & Tom" }], "Anna")).toBe(0);
    expect(pairForName([], "Anna")).toBe(0);
  });
});

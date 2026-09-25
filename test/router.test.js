import { describe, expect, it } from "vitest";
import { parse } from "../public/js/router.js";

const at = (href) => parse(new URL(href, "https://formation.nils-meier.de"));

describe("Adresse → Bereich", () => {
  it("kennt die Bereiche der App", () => {
    expect(at("/")).toEqual({ view: "choreo", path: "/" });
    expect(at("/videos")).toEqual({ view: "videos", path: "/videos" });
    expect(at("/videos/")).toEqual({ view: "videos", path: "/videos" });
    expect(at("/upload")).toEqual({ view: "upload", path: "/upload" });
    expect(at("/videos/abc-123")).toEqual({ view: "player", id: "abc-123", path: "/videos/abc-123" });
  });

  it("schreibt alte Adressen um (geteilte Links, installierte App)", () => {
    expect(at("/choreo/")).toEqual({ view: "choreo", path: "/" });
    expect(at("/choreo")).toEqual({ view: "choreo", path: "/" });
    expect(at("/index.html")).toEqual({ view: "choreo", path: "/" });
    expect(at("/upload.html")).toEqual({ view: "upload", path: "/upload" });
    expect(at("/video?id=abc-123")).toEqual({ view: "player", id: "abc-123", path: "/videos/abc-123" });
    expect(at("/video.html?id=abc-123").path).toBe("/videos/abc-123");
    expect(at("/video")).toEqual({ view: "videos", path: "/videos" });
  });

  it("kodiert IDs sauber", () => {
    expect(at("/video?id=a%20b").path).toBe("/videos/a%20b");
    expect(at("/videos/a%20b").id).toBe("a b");
  });

  it("schickt Unbekanntes in den Planer", () => {
    expect(at("/gibtsnicht")).toEqual({ view: "choreo", path: "/" });
    expect(at("/videos/a/b")).toEqual({ view: "choreo", path: "/" });
  });
});

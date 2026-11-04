import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BUILD } from "../public/js/build.js";

// So, wie der Server die Dateien ausliefert (Tests laufen im Worker, ohne Dateisystem)
const read = async (path) => (await env.ASSETS.fetch(`https://formation.test${path}`)).text();

describe("Stand der App-Dateien", () => {
  it("index.html, build.js und sw.js nennen denselben Stand", async () => {
    expect(BUILD).toMatch(/^\d+$/);
    expect(await read("/")).toContain(`<html lang="de" data-build="${BUILD}">`);
    expect(await read("/sw.js")).toContain(`const VERSION = "v${BUILD}";`);
  });
  it("build.js liegt im Grund-Cache des Service Workers", async () => {
    expect(await read("/sw.js")).toContain('"/js/build.js"');
  });
});

// Anmelden mit einem Code; die App merkt sich die Rolle per Cookie ein Jahr lang.
import { clearSessionCookie, roleFor, roleForCode, sessionCookie } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";

// POST /api/session { code } → { role } + Cookie
export async function login(request, env) {
  const { code } = await readJson(request);
  const role = await roleForCode(String(code ?? "").trim(), env);
  if (!role) throw new HttpError(401, "Code ist falsch");
  return json({ role }, 200, { "set-cookie": await sessionCookie(role, env) });
}

// GET /api/session → { role: "tagger" | "group" | null }
export async function current(request, env) {
  return json({ role: await roleFor(request, env) });
}

// DELETE /api/session → abmelden
export async function logout() {
  return json({ role: null }, 200, { "set-cookie": clearSessionCookie() });
}

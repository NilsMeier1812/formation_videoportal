// Verdrahtung der Datenschicht. Für den Umzug nach Cloudflare wird nur hier
// der Supabase-Adapter gegen den Adapter für die eigene API getauscht.
import { local } from "./local.js";
import { createRepository } from "./repository.js";
import { createSupabaseRemote } from "./supabase.js";

export const remote = createSupabaseRemote();
export const repo = createRepository(remote);
export { local };

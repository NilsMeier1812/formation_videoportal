// Verdrahtung der Datenschicht: eigene API (Cloudflare) + lokaler Spiegel.
import { createApiRemote } from "./api.js";
import { local } from "./local.js";
import { createRepository } from "./repository.js";

export const remote = createApiRemote();
export const repo = createRepository(remote);
export { local };

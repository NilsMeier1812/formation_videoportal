// Choreos, Tänze, Audios und Tags – einmal geladen, von allen Bereichen genutzt.
// Nach jeder Änderung (Admin) neu laden: library.load(true). Feuert dann
// window "librarychange".
import { api } from "./api.js";

let data = { choreos: [], tags: [], audios: [] };
let loading = null;

const byId = (list, id) => list.find((x) => x.id === id) || null;

export const library = {
  get data() { return data; },

  load(force = false) {
    if (!loading || force) {
      loading = api("/api/library")
        .then((fresh) => {
          data = fresh;
          window.dispatchEvent(new Event("librarychange"));
          return data;
        })
        .catch((err) => {
          loading = null; // beim nächsten Mal erneut versuchen
          throw err;
        });
    }
    return loading;
  },

  choreo(id) { return byId(data.choreos, id); },
  tag(id) { return byId(data.tags, id); },
  audio(id) { return byId(data.audios, id); },
  dance(id) {
    for (const c of data.choreos) {
      const d = byId(c.dances, id);
      if (d) return d;
    }
    return null;
  },
  dancesOf(choreoId) { return library.choreo(choreoId)?.dances || []; },
  audiosOf(choreoId) { return data.audios.filter((a) => a.choreo_id === choreoId); },

  /** Anzeigename eines Videos: eigener Titel, sonst Choreo · Tänze · Tags. */
  videoTitle(video) {
    if (video.title) return video.title;
    const parts = [
      library.choreo(video.choreo_id)?.title,
      video.dance_ids.map((id) => library.dance(id)?.name).filter(Boolean).join(" & "),
      video.tag_ids.map((id) => library.tag(id)?.name).filter(Boolean).join(", "),
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "Noch nicht zugeordnet";
  },
};

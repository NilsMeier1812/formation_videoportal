// Choreos, Tänze, Audios und Tags – das Gerüst, an dem Videos hängen.
//
//   Choreo  ── genau eine Hauptaudio (main_project_id)
//    ├─ Tänze
//    └─ Audios (= Planer-Projekte), jede mit einem oder mehreren Tänzen
//
// Lesen: für alle (private Audios nur für Trainer). Ändern: nur mit Trainer-Code.
import { hasRole, requireRole, roleFor } from "../lib/auth.js";
import { HttpError, json, readJson } from "../lib/http.js";
import { idList, optionalText } from "../lib/validate.js";

function requiredName(value, field, max = 80) {
  const name = optionalText(value, max, field);
  if (!name) throw new HttpError(400, `${field} fehlt`);
  return name;
}

/** SQLite-Constraint-Fehler → 409 statt 500 (z. B. Tag-Name doppelt). */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, "Den Namen gibt es schon");
    if (/constraint|FOREIGN KEY/i.test(String(err?.message))) throw new HttpError(409, "Passt nicht zu den vorhandenen Daten");
    throw err;
  }
}

async function exists(env, table, id) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first());
}

// GET /api/library – alles auf einmal (klein: eine Handvoll Choreos und Tags)
export async function getLibrary(request, env) {
  const trainer = hasRole(await roleFor(request, env), "tagger");
  const [choreos, dances, tags, audios, links] = await env.DB.batch([
    env.DB.prepare("SELECT id, title, main_project_id, sort_index FROM choreos ORDER BY sort_index, title"),
    env.DB.prepare("SELECT id, choreo_id, name, sort_index FROM dances ORDER BY sort_index, name"),
    env.DB.prepare("SELECT id, name, sort_index FROM tags ORDER BY sort_index, name"),
    env.DB.prepare(
      `SELECT id, title, choreo_id, is_private FROM projects ${trainer ? "" : "WHERE is_private = 0"} ORDER BY title`
    ),
    env.DB.prepare("SELECT project_id, dance_id FROM project_dances"),
  ]);
  const dancesOf = (projectId) => links.results.filter((l) => l.project_id === projectId).map((l) => l.dance_id);
  return json({
    choreos: choreos.results.map((c) => ({ ...c, dances: dances.results.filter((d) => d.choreo_id === c.id) })),
    tags: tags.results,
    audios: audios.results.map((a) => ({ ...a, is_private: Boolean(a.is_private), dance_ids: dancesOf(a.id) })),
  });
}

// ---------------- Choreos ----------------

// POST /api/choreos { title }
export async function createChoreo(request, env) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  const id = crypto.randomUUID();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM choreos").first();
  await env.DB.prepare("INSERT INTO choreos (id, title, sort_index, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, requiredName(body.title, "Titel"), n, new Date().toISOString()).run();
  return json({ id }, 201);
}

// PATCH /api/choreos/:id { title?, main_project_id?, sort_index? }
export async function updateChoreo(request, env, id) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  if (!(await exists(env, "choreos", id))) throw new HttpError(404, "Choreo nicht gefunden");
  const statements = [];
  if ("title" in body) {
    statements.push(env.DB.prepare("UPDATE choreos SET title = ? WHERE id = ?").bind(requiredName(body.title, "Titel"), id));
  }
  if ("sort_index" in body) {
    const sort = Number(body.sort_index);
    if (!Number.isInteger(sort)) throw new HttpError(400, "Ungültige Reihenfolge");
    statements.push(env.DB.prepare("UPDATE choreos SET sort_index = ? WHERE id = ?").bind(sort, id));
  }
  if ("main_project_id" in body) {
    const projectId = body.main_project_id || null;
    if (projectId) {
      const project = await env.DB.prepare("SELECT choreo_id FROM projects WHERE id = ?").bind(projectId).first();
      if (!project) throw new HttpError(400, "Audio gibt es nicht");
      if (project.choreo_id !== id) throw new HttpError(400, "Die Hauptaudio muss zur Choreo gehören");
    }
    statements.push(env.DB.prepare("UPDATE choreos SET main_project_id = ? WHERE id = ?").bind(projectId, id));
  }
  if (statements.length) await env.DB.batch(statements);
  return new Response(null, { status: 204 });
}

// DELETE /api/choreos/:id – Tänze gehen mit; Audios und Videos bleiben, nur ohne Choreo
export async function deleteChoreo(request, env, id) {
  await requireRole(request, env, "tagger");
  const { meta } = await env.DB.prepare("DELETE FROM choreos WHERE id = ?").bind(id).run();
  if (!meta.changes) throw new HttpError(404, "Choreo nicht gefunden");
  return new Response(null, { status: 204 });
}

// ---------------- Tänze ----------------

// POST /api/choreos/:id/dances { name }
export async function createDance(request, env, choreoId) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  if (!(await exists(env, "choreos", choreoId))) throw new HttpError(404, "Choreo nicht gefunden");
  const id = crypto.randomUUID();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM dances WHERE choreo_id = ?").bind(choreoId).first();
  await env.DB.prepare("INSERT INTO dances (id, choreo_id, name, sort_index) VALUES (?, ?, ?, ?)")
    .bind(id, choreoId, requiredName(body.name, "Name"), n).run();
  return json({ id }, 201);
}

// PATCH /api/dances/:id { name }
export async function updateDance(request, env, id) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  const { meta } = await env.DB.prepare("UPDATE dances SET name = ? WHERE id = ?")
    .bind(requiredName(body.name, "Name"), id).run();
  if (!meta.changes) throw new HttpError(404, "Tanz nicht gefunden");
  return new Response(null, { status: 204 });
}

// DELETE /api/dances/:id – Zuordnungen zu Audios und Videos gehen mit
export async function deleteDance(request, env, id) {
  await requireRole(request, env, "tagger");
  const { meta } = await env.DB.prepare("DELETE FROM dances WHERE id = ?").bind(id).run();
  if (!meta.changes) throw new HttpError(404, "Tanz nicht gefunden");
  return new Response(null, { status: 204 });
}

// ---------------- Audios (Planer-Projekte) ----------------

/**
 * PUT /api/audios/:id { choreo_id, dance_ids } – Audio einer Choreo zuordnen.
 * Hat die Choreo noch keine Hauptaudio, wird diese es. Wechselt die Audio die Choreo,
 * verliert die alte Choreo sie als Hauptaudio.
 */
export async function assignAudio(request, env, projectId) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  const project = await env.DB.prepare("SELECT id, choreo_id FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) throw new HttpError(404, "Audio nicht gefunden");

  const choreoId = body.choreo_id || null;
  if (choreoId && !(await exists(env, "choreos", choreoId))) throw new HttpError(400, "Choreo gibt es nicht");
  const danceIds = choreoId ? idList(body.dance_ids ?? [], "Tänze") : [];
  if (danceIds.length) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM dances WHERE choreo_id = ? AND id IN (${danceIds.map(() => "?").join(", ")})`
    ).bind(choreoId, ...danceIds).all();
    if (results.length !== danceIds.length) throw new HttpError(400, "Tanz gehört nicht zur Choreo");
  }

  const statements = [
    env.DB.prepare("UPDATE projects SET choreo_id = ? WHERE id = ?").bind(choreoId, projectId),
    env.DB.prepare("DELETE FROM project_dances WHERE project_id = ?").bind(projectId),
    ...danceIds.map((d) => env.DB.prepare("INSERT INTO project_dances (project_id, dance_id) VALUES (?, ?)").bind(projectId, d)),
  ];
  if (project.choreo_id && project.choreo_id !== choreoId) {
    statements.push(env.DB.prepare("UPDATE choreos SET main_project_id = NULL WHERE id = ? AND main_project_id = ?")
      .bind(project.choreo_id, projectId));
  }
  if (choreoId) {
    statements.push(env.DB.prepare("UPDATE choreos SET main_project_id = ? WHERE id = ? AND main_project_id IS NULL")
      .bind(projectId, choreoId));
  }
  await guarded(() => env.DB.batch(statements));
  return new Response(null, { status: 204 });
}

// ---------------- Tags ----------------

// POST /api/tags { name }
export async function createTag(request, env) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  const id = crypto.randomUUID();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM tags").first();
  await guarded(() => env.DB.prepare("INSERT INTO tags (id, name, sort_index) VALUES (?, ?, ?)")
    .bind(id, requiredName(body.name, "Name", 40), n).run());
  return json({ id }, 201);
}

// PATCH /api/tags/:id { name }
export async function updateTag(request, env, id) {
  await requireRole(request, env, "tagger");
  const body = await readJson(request);
  const { meta } = await guarded(() => env.DB.prepare("UPDATE tags SET name = ? WHERE id = ?")
    .bind(requiredName(body.name, "Name", 40), id).run());
  if (!meta.changes) throw new HttpError(404, "Tag nicht gefunden");
  return new Response(null, { status: 204 });
}

// DELETE /api/tags/:id – verschwindet auch an den Videos
export async function deleteTag(request, env, id) {
  await requireRole(request, env, "tagger");
  const { meta } = await env.DB.prepare("DELETE FROM tags WHERE id = ?").bind(id).run();
  if (!meta.changes) throw new HttpError(404, "Tag nicht gefunden");
  return new Response(null, { status: 204 });
}

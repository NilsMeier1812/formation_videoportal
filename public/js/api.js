const CODE_KEY = "portal.code";
const NAME_KEY = "portal.name";

// localStorage kann in privaten Fenstern fehlen oder werfen – dann eben ohne Merken.
function load(key) {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* egal */ }
}

export const getCode = () => load(CODE_KEY);
export const setCode = (code) => save(CODE_KEY, code);
export const getName = () => load(NAME_KEY);
export const setName = (name) => save(NAME_KEY, name);

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body, code } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const portalCode = code ?? getCode();
  if (portalCode) headers["x-portal-code"] = portalCode;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Fehler ${res.status}`);
  return data;
}

/** Kleiner DOM-Helfer; Text immer über textContent, nie als HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
  return `${value.toFixed(i >= 2 ? 1 : 0).replace(".", ",")} ${units[i]}`;
}

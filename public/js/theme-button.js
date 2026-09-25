// Knopf in der Kopfzeile der Video-Seiten: schaltet Automatisch → Hell → Dunkel.
// (Im Planer sitzt dieselbe Wahl im Menü.)
const ICONS = {
  system: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dark: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};

export function mountThemeButton(button) {
  const theme = window.formationTheme;
  if (!button || !theme) return;
  const render = () => {
    const mode = theme.mode;
    button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[mode]}</svg>`;
    const label = `Darstellung: ${theme.labels[mode]} (tippen zum Wechseln)`;
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  button.addEventListener("click", () => theme.cycle());
  window.addEventListener("themechange", render);
  render();
}

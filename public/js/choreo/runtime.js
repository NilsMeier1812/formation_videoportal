// Nicht-reaktiver Laufzeitzustand, den mehrere Bereiche teilen.
// Bewusst außerhalb von Alpine: Wavesurfer-Objekte und Canvas-Kontexte vertragen
// keine Proxys, und Werte, die sich jeden Frame ändern, sollen keine
// Reaktivität auslösen.
export const rt = {
  // Wavesurfer
  ws: null,
  wsRegions: null,
  webAudioFailed: false, // WebAudio klappte nicht → Fallback auf <audio>
  currentObjectUrl: null,

  palette: null, // Farben aus theme.css, siehe canvas.refreshPalette()

  // Canvas-Overlays über der Welle
  gridCanvas: null,
  gridCtx: null,
  laneCanvas: null,
  laneCtx: null,
  phWave: null, // Playhead über der Welle
  phLane: null, // Playhead über den Spuren
  drawRaf: 0, // EIN requestAnimationFrame für Grid + Spuren
  pxPerSec: 0, // nur bei Zoom/Resize neu berechnet
  viewStart: 0, // Zeit am linken Rand des Sichtfensters
  onResize: null,

  // Wiedergabe-Uhr (Interpolation zwischen groben Media-Zeitstempeln)
  playRaf: 0,
  clockT: 0,
  clockP: null,

  // Audio-Laden
  loadToken: 0, // verhindert Races bei schnellem Projektwechsel
  audioSource: null, // 'cache' | 'network'
  audioRefetchTried: false,
  audioTimeout: null,

  // Sonstiges
  heartbeatTimer: null,
  lastActiveSegmentId: null,
  lastFoot: { herren: null, damen: null }, // für Auto-Fußwechsel beim Eintragen
  longPress: { timer: null, handled: false, moved: false, x: 0, y: 0, role: null, time: 0 },
  noteStep: null, // Schritt, dessen Notiz gerade im Popup bearbeitet wird
  upload: null, // laufender Audio-Upload { abort }
};

// Vorschaubild und Länge eines Videos im Browser erzeugen – vor dem Hochladen, aus
// der lokalen Datei. Kann der Browser das Video nicht abspielen (z. B. HEVC vom
// iPhone auf manchen Android-Geräten), gibt es eben kein Bild: Ergebnis null.

const WIDTH = 480;

/** @returns {Promise<{ blob: Blob|null, duration: number|null }>} */
export function makeThumbnail(file, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let duration = null;
    let done = false;
    const finish = (blob) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve({ blob, duration });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("error", () => finish(null));
    video.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(video.duration)) duration = video.duration;
      // Nicht das erste Bild (oft schwarz/verwackelt), aber früh im Video
      video.currentTime = Math.min(1, (duration || 2) / 2);
    });
    video.addEventListener("seeked", () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) { finish(null); return; }
      const scale = Math.min(1, WIDTH / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      try {
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.75);
      } catch {
        finish(null);
      }
    }, { once: true });
    video.src = url;
  });
}

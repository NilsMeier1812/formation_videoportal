#!/usr/bin/env bash
# Abspielfassung eines Videos erzeugen (läuft im GitHub-Workflow process-video.yml,
# lässt sich aber auch lokal testen).
#
#   scripts/process-video.sh <eingabe> <ausgabe-ordner> [thumb]
#
# Ergebnis im Ausgabe-Ordner: play.mp4 (H.264, 8 Bit, SDR, kürzere Seite ≤ 1080 px,
# faststart, ohne Metadaten wie GPS) und – mit „thumb“ – thumb.jpg.
# Auf stdout eine Zeile JSON: {"mode":"copy|encode","duration":…,"play_size":…,"thumb":true|false}
#
# Grundsatz: so selten wie möglich neu kodieren.
#   copy    Video ist schon H.264, 8 Bit (yuv420p), SDR und höchstens 1080p → nur umverpacken,
#           Bild bleibt Bit für Bit gleich (Ton wird nur umgewandelt, wenn er kein AAC ist).
#   encode  alles andere (iPhone-HEVC, 4K, HDR, 10 Bit, VP9 …) → H.264 in hoher Qualität,
#           HDR per Tone-Mapping nach SDR (sonst wirkt es blass).
set -euo pipefail

IN="$1"
OUT="$2"
WANT_THUMB="${3:-}"
MAX=1080  # kürzere Seite (quer: Höhe, hochkant: Breite)
mkdir -p "$OUT"

probe() { ffprobe -v error -select_streams "$1" -show_entries "stream=$2" -of default=nw=1:nk=1 "$IN" | head -n1; }

VCODEC=$(probe v:0 codec_name)
PIX=$(probe v:0 pix_fmt)
W=$(probe v:0 width)
H=$(probe v:0 height)
TRC=$(probe v:0 color_transfer || true)
ACODEC=$(probe a:0 codec_name || true)
SHORT=$(( W < H ? W : H ))

HDR=0
if [[ "$TRC" == "arib-std-b67" || "$TRC" == "smpte2084" ]]; then HDR=1; fi

# Ton: AAC übernehmen, sonst nach AAC; ohne Tonspur einfach ohne
if [[ -z "$ACODEC" ]]; then AUDIO=(-an)
elif [[ "$ACODEC" == "aac" ]]; then AUDIO=(-c:a copy)
else AUDIO=(-c:a aac -b:a 160k)
fi

COMMON=(-map 0:v:0 -map "0:a:0?" -map_metadata -1 -map_chapters -1 -movflags +faststart)

if [[ "$VCODEC" == "h264" && "$PIX" == "yuv420p" && "$HDR" == 0 && "$SHORT" -le "$MAX" ]]; then
  MODE=copy
  ffmpeg -hide_banner -loglevel error -y -i "$IN" "${COMMON[@]}" -c:v copy "${AUDIO[@]}" "$OUT/play.mp4"
else
  MODE=encode
  # kürzere Seite auf höchstens 1080 px (nie vergrößern) – für quer und hochkant
  SCALE="scale=w='if(gt(iw,ih),-2,min(${MAX},iw))':h='if(gt(iw,ih),min(${MAX},ih),-2)'"
  TM=""
  if [[ "$HDR" == 1 ]]; then
    TM="zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
  fi
  # erst verkleinern (billig), dann tone-mappen; yuv420p ist Pflicht (10-Bit-H.264 spielt kaum ein Browser)
  ffmpeg -hide_banner -loglevel error -y -i "$IN" "${COMMON[@]}" \
    -vf "${SCALE},${TM}format=yuv420p" \
    -c:v libx264 -crf 20 -preset faster -profile:v high \
    -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
    "${AUDIO[@]}" "$OUT/play.mp4"
fi

DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT/play.mp4")
SIZE=$(stat -c%s "$OUT/play.mp4")

THUMB=false
if [[ "$WANT_THUMB" == "thumb" ]]; then
  SS=$(awk -v d="$DUR" 'BEGIN { print (d > 2) ? 1 : 0 }')
  ffmpeg -hide_banner -loglevel error -y -ss "$SS" -i "$OUT/play.mp4" -frames:v 1 \
    -vf "scale=w='if(gt(iw,ih),480,-2)':h='if(gt(iw,ih),-2,480)'" -q:v 4 "$OUT/thumb.jpg"
  THUMB=true
fi

printf '{"mode":"%s","duration":%s,"play_size":%s,"thumb":%s}\n' "$MODE" "$DUR" "$SIZE" "$THUMB"

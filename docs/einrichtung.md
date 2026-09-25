# Einrichtung: Schutz, Umwandlung, Upload in Teilen, E-Mails

Alles im Browser, einmalig. Die App läuft auch ohne diese Schritte weiter – es fehlt dann
nur die jeweilige Funktion (Videos bleiben z. B. unumgewandelt und spielen das Original).

> Werte von Codes, Tokens und Schlüsseln nie in den Chat, ins Repo oder in `wrangler.toml` schreiben –
> immer als **Secret** eintragen.

## 1. Zugangsschutz (nach dem Merge)

1. **Öffentliche Media-Domain abschalten:** Cloudflare → *R2* → `formation-videos` → *Settings* →
   *Custom Domains* → `media.formation.nils-meier.de` → *Remove*. Die App liefert Videos jetzt selbst aus
   (`/media/…`, nur mit Anmeldung). *Public Development URL (r2.dev)* bleibt deaktiviert.
2. **Budget-Alarm:** *Manage Account* → *Billing* → *Billable Usage* → *Budget alerts* → etwa 5 $.
3. Der Gruppe den **Gruppen-Code** geben – jede und jeder gibt ihn einmal beim Öffnen der App ein.

## 2. Umwandlung (GitHub Actions)

**a) R2-Schlüssel für GitHub** (ein eigener, damit man ihn getrennt austauschen kann):
Cloudflare → *R2* → *Manage R2 API Tokens* (rechts oben bzw. unter *Account details*) → *Create API token*:
- Permissions: **Object Read & Write**
- Specify bucket: **nur** `formation-videos`
- *Create* → **Access Key ID** und **Secret Access Key** kopieren (werden nur einmal angezeigt).

**b) Rückmelde-Geheimnis** ausdenken: eine lange Zufallsfolge (z. B. vom Passwort-Manager, 40 Zeichen).
Dasselbe Geheimnis kommt gleich an zwei Stellen hin.

**c) GitHub-Secrets:** Repo `formation_videoportal` → *Settings* → *Secrets and variables* → *Actions* →
*New repository secret*, drei Stück:
- `R2_ACCESS_KEY_ID` – aus a)
- `R2_SECRET_ACCESS_KEY` – aus a)
- `CALLBACK_SECRET` – aus b)

**d) GitHub-Token, mit dem der Worker die Umwandlung startet:** GitHub → Profilbild → *Settings* →
*Developer settings* → *Personal access tokens* → *Fine-grained tokens* → *Generate new token*:
- Expiration: 1 Jahr – **Ablaufdatum in den Kalender** (danach bleiben neue Videos unumgewandelt)
- Repository access: *Only select repositories* → `formation_videoportal`
- Permissions → Repository permissions → **Actions: Read and write** (sonst nichts)
- *Generate token* → kopieren.

**e) Worker-Secrets:** Cloudflare → *Workers & Pages* → `formation-portal` → *Settings* →
*Variables and Secrets* → *Add*, jeweils Typ **Secret**:
- `GH_TOKEN` – aus d)
- `CALLBACK_SECRET` – derselbe Wert wie in b)

**Test:** ein Video hochladen → GitHub → *Actions* → „Video umwandeln“ läuft (meist 1–5 Minuten).
Danach steht im Player kein „wird noch umgewandelt“ mehr. Schon vorher hochgeladene Videos holt der
stündliche Cron nach.

**Was passiert:** Schon passende Videos (H.264, 8 Bit, kein HDR, höchstens 1080p – typisch Android)
werden nur umverpackt, ohne Qualitätsverlust. Alles andere (iPhone-HEVC, 4K, HDR) wird in 1080p H.264
umgewandelt, HDR in normale Farben. GPS und andere Metadaten fliegen raus. Das Original wird
**7 Tage** nach der Umwandlung gelöscht.

## 3. Upload in Teilen (R2-CORS)

Damit der Browser die Teile zusammensetzen kann, muss er die Antwort-Kopfzeile `ETag` lesen dürfen.
Cloudflare → *R2* → `formation-videos` → *Settings* → *CORS Policy* → *Edit* und so einstellen:

```json
[
  {
    "AllowedOrigins": ["https://formation.nils-meier.de"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Neu ist nur `"ExposeHeaders": ["ETag"]`. Fehlt es, scheitern Uploads ab 32 MB mit dem Hinweis
„ETag nicht lesbar“.

## 4. E-Mails (Resend)

Cloudflare → `formation-portal` → *Settings* → *Variables and Secrets* → *Add*, Typ **Secret**:
- `RESEND_API_KEY` – dein Resend-Schlüssel
- `MAIL_TO` – deine Adresse (Empfänger aller Admin-Mails)

Absender ist `Formation <formation@nils-meier.de>` (Variable `MAIL_FROM` in `wrangler.toml`). Die Domain
muss bei Resend verifiziert sein – ist sie eine andere, `MAIL_FROM` anpassen.

**Was kommt:** eine Mail bei jedem Upload ab 1 GB (`NOTIFY_FILE_BYTES`) und montags früh eine
Wochenübersicht (neue Videos, noch nicht zugeordnet, fehlgeschlagene Umwandlungen, Speicher) – nur,
wenn es etwas zu berichten gibt.

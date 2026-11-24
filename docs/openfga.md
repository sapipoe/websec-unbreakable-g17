# OpenFGA: overdracht stap 3 → stap 4-6

Opdracht 4. OpenFGA is onze **PDP** (Policy Decision Point): de API (de PEP) vraagt
bij elk verzoek aan OpenFGA of de gebruiker iets mag. De API beslist dat niet meer zelf
met `WHERE Recipient = ...`.

## Wat staat er al (stap 3)

| Onderdeel | Waar | Opmerking |
|---|---|---|
| `openfga` (v1.23.0) | `docker-compose.yml` | HTTP-API op poort 8080, gRPC op 8081. **Geen** publieke poort, niet achter BunkerWeb. |
| `openfga-migrate` | `docker-compose.yml` | Maakt de tabellen aan bij elke deploy en stopt dan. |
| `openfga-db` (postgres:17) | `docker-compose.yml` | Eigen databank en volume `fgadata`. Enkel op het netwerk `openfga`. |
| Netwerk `authz` (internal) | `docker-compose.yml` | Enkel `app` en `openfga`. Zo kan de app OpenFGA bereiken. |
| Netwerk `openfga` (internal) | `docker-compose.yml` | Enkel `openfga` en `openfga-db`. |
| Model | `openfga/model.fga` | Zie hieronder. |
| Store aanmaken | `openfga/init-store.sh` | Eenmalig op de server gedraaid, **niet** in de pipeline. |
| Health check | `.github/workflows/pipeline.yml` | De deploy faalt als `openfga` niet binnen 3 minuten `healthy` is. |

## Verbinding vanuit de API

| Instelling (sectie `OpenFga`) | Omgevingsvariabele in de app | Waarde | Geheim? |
|---|---|---|---|
| `OpenFga:ApiUrl` | `OpenFga__ApiUrl` | `http://openfga:8080` (staat al in `docker-compose.yml`) | nee |
| `OpenFga:PresharedKey` | `OpenFga__PresharedKey` | GitHub secret `OPENFGA_PRESHARED_KEY` | **ja** |
| `OpenFga:StoreId` | nog toe te voegen (stap 4) | `____________________________` | nee |
| `OpenFga:AuthorizationModelId` | nog toe te voegen (stap 4) | `____________________________` | nee |

- **Adres**: `http://openfga:8080`. Werkt enkel vanuit containers op het netwerk `authz`
  (dus de app). Vanaf het internet of via `/` op ons domein kan je OpenFGA niet bereiken.
- **Sleutel**: GitHub secret `OPENFGA_PRESHARED_KEY` → de stap "App bouwen en starten" in
  `pipeline.yml` → `${OPENFGA_PRESHARED_KEY}` in `docker-compose.yml` → zowel
  `OPENFGA_AUTHN_PRESHARED_KEYS` van `openfga` als `OpenFga__PresharedKey` van de app.
  De API stuurt die mee als `Authorization: Bearer <sleutel>`. Zonder of met een foute
  sleutel antwoordt OpenFGA `401`. Nooit in `appsettings.json` of in code zetten.
  Met OpenFga.Sdk:
  ```csharp
  Credentials = new Credentials {
      Method = CredentialsMethod.ApiToken,
      Config = new CredentialsConfig { ApiToken = cfg["PresharedKey"] }
  }
  ```
- **Store-ID en model-ID**: komen uit de uitvoer van `openfga/init-store.sh` (ingevuld in de
  tabel hierboven). Ze zijn niet geheim: zet ze als `OpenFga__StoreId` en
  `OpenFga__AuthorizationModelId` bij de app in `docker-compose.yml` (of in `appsettings.json`).
  Geef het model-ID altijd mee bij Check en ListObjects. Zonder model-ID gebruikt OpenFGA het
  nieuwste model van de store. Wie dan een ander model wegschrijft, verandert stilletjes de rechten.
- Tip voor stap 4: zet bij de app `depends_on: openfga: condition: service_healthy`, zodat de
  API pas start als de PDP klaar is.

## Het model

```
type user
type message
  relations
    define sender: [user]
    define recipient: [user]
    define can_read: recipient
    define can_delete: sender
```

- `user:<sub>`: `<sub>` is de claim `sub` uit het token (de UUID die `CurrentUser()` teruggeeft).
- `message:<id>`: `<id>` is `Messages.Id` (int), bv. `message:42`.
- **Lezen = enkel de ontvanger. Verwijderen = enkel de afzender.** De afzender kan zijn eigen
  verzonden bericht dus niet lezen, en de ontvanger kan het niet verwijderen. Dat is zo bedoeld.

## Wat de API moet doen (stap 4-6)

**Fail closed**: kan de API OpenFGA niet bereiken (exception, timeout), dan antwoordt de API
met een fout (`503`) en **nooit** alsof het toegelaten is.

### POST /api/messages (nieuw bericht)

Na `SaveChangesAsync()` (dan pas bestaat `message.Id`) **twee tuples in één Write-verzoek**
(één Write is atomair: allebei of geen van beide):

| user | relation | object |
|---|---|---|
| `user:<message.Sender>` (sub uit het token) | `sender` | `message:<message.Id>` |
| `user:<message.Recipient>` (sub van de ontvanger) | `recipient` | `message:<message.Id>` |

Mislukt de Write, verwijder dan het bericht weer uit de databank en geef `503`. Anders blijft
er een bericht achter dat niemand kan lezen of verwijderen.

### GET /api/messages/{id}

`Check(user:<sub>, can_read, message:<id>)` **vóór** het bericht uit de databank gehaald wordt.
- `false` → `404` (aanbevolen: zo verraad je niet of een bericht met dat id bestaat) of `403`.
- `true` → bericht ophalen zoals nu.

Nu kan **iedereen** met een token elk bericht lezen door het id te raden (IDOR). Dit lost dat op.

### DELETE /api/messages/{id}

1. `Check(user:<sub>, can_delete, message:<id>)`. `false` → `404`/`403`, niets verwijderen.
2. Bericht uit de databank halen (je hebt `Sender` en `Recipient` nodig) en verwijderen.
3. **De twee tuples verwijderen** (Write met `Deletes`): dezelfde twee als bij POST.
   Anders blijven er rechten bestaan op een id dat niet meer bestaat.

### Inbox, zoeken en export: ListObjects

`ListObjects(user:<sub>, can_read, type message)` geeft een lijst als
`["message:12", "message:15"]`. Haal daar de ids uit en filter in de databank op die ids:

| Endpoint | Nu | Straks |
|---|---|---|
| `GET /api/messages` (inbox, ook `?from=`) | `Where(m => m.Recipient == user)` | `Where(m => ids.Contains(m.Id))`, `from` blijft een gewone filter |
| `GET /api/messages/search?q=` | **SQL-injectie**: `q` en `user` in een SQL-string | ids uit ListObjects + LINQ met `EF.Functions.ILike(...)`, geen `FromSqlRaw` met strings |
| `GET /api/messages/export` | `Where(m => m.Recipient == user)` | `Where(m => ids.Contains(m.Id))` |

Let op: ListObjects geeft standaard maximaal 1000 resultaten (`OPENFGA_LIST_OBJECTS_MAX_RESULTS`).
Voor onze app is dat genoeg.

### Bestaande berichten

Berichten die al op de server staan (verstuurd sinds stap 2) hebben **nog geen tuples**. Na
stap 4 zijn ze voor niemand zichtbaar. Schrijf ze eenmalig weg (een klein script of een
eenmalige backfill bij het opstarten), of verwijder ze.

## Handig op de server: de CLI

OpenFGA heeft geen publieke poort, dus gebruik de CLI-container op het interne netwerk:

```bash
read -rs OPENFGA_PRESHARED_KEY && export FGA_API_TOKEN="$OPENFGA_PRESHARED_KEY"
fga() { docker run --rm --network unbreakable_authz \
          -e FGA_API_URL=http://openfga:8080 -e FGA_API_TOKEN \
          -e FGA_STORE_ID=<store-ID> openfga/cli:v0.9.0 "$@"; }

fga tuple read                                               # alle tuples
fga query check user:<sub> can_read message:42               # mag deze gebruiker bericht 42 lezen?
fga query list-objects user:<sub> can_read message           # wat mag deze gebruiker lezen?
```

## Geheimen (GitHub → Settings → Secrets and variables → Actions)

| Secret | Gebruikt door | Aanmaken met |
|---|---|---|
| `OPENFGA_DB_PASSWORD` | `openfga-db`, `openfga-migrate`, `openfga` | `openssl rand -hex 32` |
| `OPENFGA_PRESHARED_KEY` | `openfga` (aanvaardt hem), app (stuurt hem mee) | `openssl rand -hex 32` |

Hex, omdat OpenFGA de lijst van sleutels op komma's splitst en `+ / =` in een header of
URL soms problemen geven. Let op: Postgres zet het wachtwoord enkel bij de **eerste** start
van een leeg volume. Wijzig je `OPENFGA_DB_PASSWORD` later, dan moet je het ook in de
databank zelf aanpassen (`ALTER USER openfga PASSWORD ...`).

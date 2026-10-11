# Aanvaarde bevindingen

Bevindingen uit de **eerste pipeline-run** op de ongewijzigde starter app
(run #1, commit `ad1f6cd`). De app bevat bewust zwakke plekken; die lossen we
op in latere opdrachten.

## Wat is kritiek?

| Scan | Kritiek = | Blokkeert de pipeline? |
|---|---|---|
| Secret scanning (Gitleaks) | elk gevonden geheim | ja |
| SCA (dotnet + retire.js) | severity High of Critical | ja |
| SAST (Semgrep) | severity ERROR | ja |

Alles onder die drempel wordt gemeld in het rapport, maar blokkeert niet.

## Aanvaarde kritieke bevindingen

Deze bevindingen laten de pipeline **niet** falen. Elke **nieuwe** kritieke
bevinding doet dat wel.

| # | Scan | Bevinding | Echt probleem of false positive? | Waarom mag het nu? | Wanneer opgelost? | Vastgelegd in |
|---|---|---|---|---|---|---|
| 1 | Gitleaks | API key `Notifications.ApiKey` in `app/appsettings.json:15` | **Echt probleem**: een geheim hoort niet in de repo | Het endpoint is `push.unbreakable.example`. `.example` is een gereserveerd domein dat nooit bestaat, dus de key werkt nergens. | Opdracht 6 (secrets manager, dreiging #5) | `.gitleaksignore` |
| 2 | dotnet (SCA server side) | `Newtonsoft.Json 12.0.1`, High, [GHSA-5crp-9r3c-p9vr](https://github.com/advisories/GHSA-5crp-9r3c-p9vr) | **Echt lek in de library, niet bereikbaar in de app** | Het lek zit in het *inlezen* van diep geneste JSON. De app gebruikt Newtonsoft enkel in `Program.cs:106` om eigen data te *schrijven* (`SerializeObject`). | Update naar 13.0.1 of hoger | `.sca-accepted.txt` |

## Niet-kritieke bevindingen (ter info)

| Scan | Bevinding | Severity | Opmerking |
|---|---|---|---|
| retire.js | jQuery 3.3.1: CVE-2019-11358 | Medium | Prototype pollution via `$.extend(true, ...)`; de app gebruikt dat niet. |
| retire.js | jQuery 3.3.1: CVE-2020-11022, CVE-2020-11023 | Medium | XSS via `.html()`. **Wel relevant**: `app.js:101` stopt gebruikersinvoer in `.html()`. |
| retire.js | Bootstrap 4.1.3: CVE-2019-8331 | Medium | XSS in tooltip/popover; de app gebruikt die niet. |
| Semgrep | `UseDeveloperExceptionPage()` in `Program.cs:39` | WARNING | Echt probleem: stacktraces zichtbaar in productie. |

## Wat de scans gemist hebben

- **Semgrep** vond de SQL-injectie in `/api/messages/search` (`Program.cs`) niet,
  en ook de XSS in `app.js:101` niet.
- **Gitleaks** vond het databankwachtwoord in `appsettings.json` en
  `docker-compose.yml` niet.

Een groene scan betekent dus niet dat de code veilig is.

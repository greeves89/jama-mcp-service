# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier festgehalten.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung [Semantic Versioning](https://semver.org/lang/de/).

## [1.9.0] — 2026-09-04

### Hinzugefuegt
- **Herkunftsvermerk in Jama.** Jede vom Dienst ausgeloeste Anlage oder Aenderung
  kann als Kommentar am Item vermerkt werden, mit der Person und dem verwendeten
  Zugang. Jama fuehrt zwar eine eigene Historie, dort steht aber nur der
  technische Benutzer dieser Anbindung — teilen sich mehrere Personen einen
  Zugang, war die Herkunft im Nachhinein nicht mehr zu klaeren. Schaltbar im
  Dashboard unter "Einstellungen — Nachvollziehbarkeit", standardmaessig aus,
  weil es je geaendertem Item einen zusaetzlichen Jama-Aufruf kostet.
- **Die aufrufende Person wird aus den Kopfzeilen gelesen**
  (`X-OpenWebUI-User-Name`, `-Email`, `-Id` sowie die verbreiteten Varianten
  `X-Forwarded-User` und `X-Remote-User`) und erscheint zusaetzlich im
  Audit-Log, dort vor dem Zugang.
- Abschnitt "Wer hat die Aenderung veranlasst?" in der Deployment-Anleitung.

### Hinweis zur Reichweite
Open WebUI sendet diese Kopfzeilen, sobald `ENABLE_FORWARD_USER_INFO_HEADERS`
gesetzt ist — bislang aber nur an OpenAI-kompatible Endpunkte, noch nicht an
MCP-Server ueber Streamable HTTP (open-webui Nr. 21184, offen). Bis das
nachgezogen ist, steht im Kommentar nur der verwendete Zugang; das wird dort
ausdruecklich gesagt statt eine Herkunft vorzutaeuschen. Zuverlaessig ist heute
ein eigener Key je Person mit eigenen Jama-Zugangsdaten — dann nennt schon
Jamas eigene Historie den richtigen Verursacher.

Die Angaben aus den Kopfzeilen sind eine Auskunft des Clients, kein Nachweis:
Wer den Key besitzt, kann jeden Namen behaupten. Die Rechte haengen deshalb
weiterhin ausschliesslich am Key. Steuerzeichen werden entfernt und die Laenge
begrenzt, damit sich darueber weder Logzeilen faelschen noch fremder Text in
Jama-Kommentare schieben laesst.

## [1.8.0] — 2026-09-04

Aufarbeitung eines Rueckmeldeprotokolls aus dem Betrieb. Nicht jeder Punkt darin
traf zu; die geprueften und bestaetigten sind hier behoben.

### Behoben
- **Die Beziehungspruefung gab falsche Auskuenfte — in beide Richtungen.** Sie
  durchsuchte saemtliche Regelwerke der Instanz, obwohl Jama nur das dem Projekt
  zugeordnete anwendet und ersatzweise das als Standard markierte. Dadurch
  meldete sie "nicht zulaessig", obwohl das Anlegen gelang (die passende Regel
  lag in einem fremden Regelwerk), und "zulaessig", obwohl Jama ablehnte (die
  gefundene Regel galt fuer ein anderes Projekt). Eine Vorpruefung, die in beide
  Richtungen irrt, ist schaedlicher als gar keine. Die Antwort nennt jetzt
  ausserdem, gegen welches Regelwerk geprueft wurde, und weist auf
  projektuebergreifende Beziehungen hin.
- Ist einem Projekt kein Regelwerk zugeordnet und existiert kein Standardwerk,
  gilt die Verknuepfung als zulaessig — Jama schraenkt dann nicht ein. Zuvor
  wurde in diesem Fall faelschlich abgeraten.

### Hinzugefuegt
- `jama_bulk_create_items` liefert auf Wunsch die Document Keys der neuen Items
  (`mitDocumentKeys`). Bewusst abschaltbar und standardmaessig aus: Jama gibt
  beim Anlegen nur die numerische ID zurueck und bietet keine Sammelabfrage, das
  Nachladen kostet also einen Aufruf je Item.
- `jama_get_project_schema` weist darauf hin, wenn die Antwort durch ihren
  Umfang gekuerzt werden koennte, und nennt die Typschluessel zum gezielten
  Nachfragen. Der Hinweis steht in den Anmerkungen und ueberlebt damit die
  Kuerzung — ein Nachsatz am Ende waere mit weggeschnitten worden.

## [1.7.0] — 2026-09-04

### Behoben
- **Sets und Ordner liessen sich nicht anlegen.** Jama verlangt fuer beide
  zwingend den Typ der spaeteren Kinder ("Sets and Folders must always have a
  child type specified"); `jama_create_container` uebermittelte ihn nicht und
  hatte auch kein Feld dafuer. Jeder Versuch endete mit 400, und zwar
  unabhaengig von den Schreibrechten. `childItemType` ist nun Bestandteil des
  Tools.
- Der Schluessel-Praefix eines Sets laesst sich ueber `setKey` mitgeben.

### Hinzugefuegt
- `childItemType` versteht die numerische ID, den Typschluessel ("RS") und den
  Anzeigenamen ("Requirement Specification Item"). Aufrufer kennen die ID fast
  nie — in der Oberflaeche steht der Name, in Document Keys der Schluessel.
- Fehlt die Angabe oder ist sie unbekannt, nennt die Fehlermeldung die
  ItemTypes, die diese Instanz tatsaechlich fuehrt, mit Name, Schluessel und ID.
  Das erspart den Umweg ueber einen Aufruf, der sicher scheitert.
- `SchemaResolver.findItemType()` als gemeinsame Aufloesung fuer alle Werkzeuge.

### Hinweis
Die Zuordnung von Typen zu IDs wird ausschliesslich zur Laufzeit aus der
angebundenen Instanz gelesen und ist nirgends im Code hinterlegt: Die IDs
unterscheiden sich zwischen Instanzen, und viele Installationen fuehren
abgeloeste Typen parallel zu ihren Nachfolgern weiter. Eine gepflegte Liste
waere anderswo schlicht falsch und wuerde Items im falschen Typ anlegen — ein
Fehler, der erst Wochen spaeter beim Auswerten auffaellt.

## [1.6.0] — 2026-09-04

### Hinzugefuegt
- **Jeder Aufruf an Jama ist jetzt nachvollziehbar.** Bisher wurde kein
  einziger protokolliert — von aussen war nicht erkennbar, welche Adressen der
  Dienst anspricht und was Jama antwortet. Auf `LOG_LEVEL=debug` erscheint jeder
  Aufruf mit Methode, Pfad, Status, Dauer und Versuchsnummer.
- **Fehlgeschlagene Jama-Aufrufe erscheinen unabhaengig vom Log-Level**, samt
  der Antwort von Jama (auf 500 Zeichen gekuerzt). Ebenso eine fehlgeschlagene
  Anmeldung: dort steht Jamas OAuth-Antwort im Klartext. Zur Unterscheidung
  mehrerer hinterlegter Zugaenge wird der Anfang der Client-ID mitgeschrieben,
  nie das Secret.
- Abschnitt "Fehlersuche: alles mitlesen" in der Deployment-Anleitung.

### Behoben
- **Bei einem abgelehnten Zugang (401) wurde Jamas Antwort verworfen.** Im
  Dashboard wie im Log stand immer derselbe allgemeine Satz, und es war nicht zu
  unterscheiden, ob die Client-ID unbekannt, das Secret falsch oder das Konto
  gesperrt war — der Betreiber konnte nur raten. `error` und
  `error_description` werden nun angehaengt, bei einer Antwort ohne JSON der
  gekuerzte Rohtext.

## [1.5.2] — 2026-09-04

### Behoben
- **Der Health-Endpunkt meldete nach jedem Update weiter "1.0.0".** Er las
  `process.env.npm_package_version`, und diese Variable setzt nur npm selbst —
  im Container startet der Dienst aber direkt als `node dist/server.js`, sodass
  dauerhaft der Ersatzwert griff. Damit war die uebliche Kontrolle nach einem
  Deployment ("steht dort die neue Version?") wertlos, und ein nicht
  eingespieltes Update waere niemandem aufgefallen. Dieselbe Zahl stand
  ausserdem fest verdrahtet in der Server-Kennung, die MCP-Clients beim
  Verbindungsaufbau sehen. Beide lesen nun aus der package.json.

## [1.5.1] — 2026-09-04

### Sicherheit
- **Die Anmeldesperre liess sich ueber einen gefaelschten `X-Forwarded-For`
  umgehen.** Sie zaehlt Fehlversuche pro Client-Adresse; diese Adresse stammte
  aus einem Header, den der Client selbst mitschicken kann. nginx haengte einen
  mitgeschickten Wert an, statt ihn zu ersetzen, und Fastify vertraute mit
  `trustProxy: true` der ganzen Kette und nahm deren linkesten — also den vom
  Angreifer gesetzten — Eintrag. Damit war die PIN unbegrenzt zu raten. Behoben
  an beiden Enden: nginx setzt den Header jetzt auf `$remote_addr`, und Fastify
  vertraut nur der ueber `TRUST_PROXY_HOPS` angegebenen Anzahl eigener Proxys.
- Drei Schwachstellen in Produktiv-Abhaengigkeiten behoben: `fast-uri` (hoch,
  SSRF und Host-Confusion), `fastify` (mittel, ebendieses
  X-Forwarded-Spoofing sowie ein Schema-Bypass) und `qs` (mittel, DoS). Alles
  Patch-Level, keine Breaking Changes.
- Das Abmelden verlangt nun ebenfalls den CSRF-Nachweis — der Schaden waere
  gering, aber alle veraendernden Routen folgen jetzt demselben Muster.

### Behoben
- Ein Kommentar behauptete, Fastify werte eine Zahl bei `trustProxy` als
  Hop-Zaehler aus. Das trifft nicht zu: Fastify verwirft sie und traut dann gar
  keinem Eintrag mehr, womit `request.ip` immer die Adresse des Proxys liefert
  und ein einziger Fehlversuch alle Anwender gemeinsam aussperrt. Ein Test haelt
  dieses Verhalten fest, damit ein spaeteres Vereinfachen zur Zahl auffaellt.

### Hinzugefuegt
- `TRUST_PROXY_HOPS` (Standard 1) samt Erlaeuterung beider Fehlerrichtungen.
- Abschnitt in der Deployment-Anleitung zur Client-Adresse hinter dem Proxy,
  mit dem Hinweis, dass ein bereits vorhandenes Traefik `X-Forwarded-For` selbst
  ueberschreiben muss, und der Invariante, dass der Anwendungs-Port niemals
  direkt nach aussen gemappt werden darf.

## [1.5.0] — 2026-09-04

### Behoben
- **Fehler waren im Containerlog nicht zu sehen.** Fastifys Request-Logging war
  abgeschaltet und die Admin-API schickte ihre Fehler ausschliesslich an den
  Browser. Wer nur `docker logs` hatte, sah einen stillen Dienst und keinen
  Hinweis auf die Ursache — bei einem fehlgeschlagenen Verbindungstest ebenso
  wie bei einer abgewiesenen Anmeldung. Jede Antwort ab Status 400 wird jetzt
  protokolliert, mit Methode, Pfad, Status, Dauer und Client-Adresse, dazu der
  Fehlercode und die Klartextmeldung. Ab 500 als Fehler samt Stacktrace,
  darunter als Warnung.
- **Fehlgeschlagene Verbindungstests blieben unsichtbar.** Sie antworten mit
  HTTP 200, weil der Test technisch durchlief — der Antwort-Hook sieht davon
  also nichts. Die Route protokolliert das Ergebnis nun selbst, im Fehlerfall
  mit der Meldung von Jama.
- Ein Test der Zeitreihe lud drizzle innerhalb der Testfunktion. Der erste
  Import kostet knapp zwei Sekunden und brachte ihn gelegentlich ueber das
  Zeitlimit — ein Fehlschlag ohne Bezug zur geprueften Sache. Die Imports stehen
  jetzt am Dateianfang, die Laufzeit sank von 1,9 s auf 13 ms.

### Hinzugefuegt
- **Begrenzung der Containerlogs auf 100 MB je Dienst** (fuenf Dateien zu je
  20 MB). Ohne diese Angabe waechst die JSON-Datei des Docker-Logtreibers
  unbegrenzt; Docker raeumt dort von sich aus nichts auf, und auf kleinen
  Maschinen laeuft darueber irgendwann die Platte voll. Die Werte stehen in den
  Compose-Dateien unter `x-logging` und gelten ueber einen YAML-Anker fuer alle
  Dienste.
- Abschnitt "Logs" in der Deployment-Anleitung: was auf welcher Stufe erscheint,
  wie die Groessenbegrenzung wirkt und warum erfolgreiche Anfragen bewusst nicht
  protokolliert werden.

## [1.4.0] — 2026-09-04

### Hinzugefuegt
- **API-Keys lassen sich im Dashboard bearbeiten.** Bisher gab es nur Anlegen,
  Deaktivieren, Rotieren und Loeschen. Ein Zugang mit falsch gesetzten Toolsets
  liess sich damit nur korrigieren, indem man ihn neu anlegte und in jedem
  angebundenen Client austauschte. Genau dieser Fall trat im Betrieb auf: ein
  Key war ohne "core" angelegt und damit unbrauchbar. Aenderbar sind jetzt Name,
  Verantwortlicher, Toolsets, Leserechte, Projekt-Allowlist, Ablaufdatum und die
  eigenen Jama-Zugangsdaten.
- Die Zugangsdaten bleiben beim Bearbeiten leer und optional — leer heisst
  "unveraendert". Weder ein Client-Secret noch ein Passwort laesst sich
  zurueckholen, um es erneut einzutippen, nur weil ein Toolset zu ergaenzen ist.
- Art des Zugangs und Jama-Verbindung sind beim Bearbeiten bewusst fest: beide
  bestimmen, gegen welche Instanz und mit welchem Rollenmodell der Key arbeitet.
  Nachtraeglich verbogen ergaeben sie einen Zugang, dessen bisherige
  Protokolleintraege nicht mehr zu ihm passen.

### Behoben
- **Ein einmal gesetztes Ablaufdatum liess sich nie wieder entfernen** — das
  Feld nahm keinen Leerwert an. Ein leeres Feld heisst jetzt ausdruecklich
  "laeuft nicht mehr ab".
- **Ein unbrauchbares Datum wurde stillschweigend uebernommen.** `new Date()`
  ergibt bei nicht lesbarer Eingabe ein ungueltiges Datum, das ungeprueft in die
  Datenbankschicht lief. Jetzt kommt eine verstaendliche Meldung.
- **Ein Key mit eigenen Zugangsdaten liess sich nicht auf die der Verbindung
  zurueckstellen.** Die Angabe konnte nur gesetzt, nicht entfernt werden.
- Ein PATCH auf eine unbekannte Key-ID lief in einen Zugriff auf undefined und
  damit in einen 500er. Jetzt kommt sauber 404.

## [1.3.0] — 2026-09-04

### Hinzugefuegt
- **Jama-Verbindungen lassen sich im Dashboard bearbeiten.** Bisher gab es nur
  Anlegen, Testen und Loeschen. Lief eine hinterlegte Anmeldung ab und Jama
  antwortete mit 401, half nur Loeschen — und das scheitert, sobald API-Keys an
  der Verbindung haengen. Der Zugang war damit dauerhaft kaputt, ohne Weg
  zurueck. Name, Adresse, Produktivkennzeichen, Anfragelimit und Zugangsdaten
  sind jetzt aenderbar.
- Die Zugangsdaten bleiben beim Bearbeiten leer und optional: leer heisst
  "unveraendert uebernehmen". Jama zeigt ein Client-Secret nur ein einziges Mal
  an, niemand hat es also parat, um nur den Namen zu korrigieren. Beim Wechsel
  der Anmeldeart sind neue Angaben dagegen Pflicht, weil ein Client-Secret kein
  Passwort ist.

### Behoben
- **Ein frueheres Testergebnis blieb nach dem Aendern stehen.** Wer Adresse oder
  Zugangsdaten wechselte, sah weiter das gruene "ok" der alten Konfiguration —
  samt Pruefdatum, das sich auf etwas anderes bezog. Der Zustand faellt jetzt auf
  "unbekannt" zurueck, bis wirklich neu geprueft wurde.
- Ein PATCH auf eine unbekannte Verbindungs-ID lief in einen Zugriff auf
  undefined und damit in einen 500er. Jetzt kommt sauber 404.
- Zwei nutzersichtbare Meldungen rund um Verbindungen standen in
  Ersatzschreibweise (ue/ae/oe) statt mit echten Umlauten.

## [1.2.3] — 2026-09-02

### Behoben
- **Zugaenge ohne das Toolset "core" waren praktisch unbrauchbar.** Ohne dieses
  Toolset fehlen `jama_list_projects`, `jama_whoami` und
  `jama_get_project_schema` — es gibt dann keinen Weg von einem Projektnamen
  oder -kuerzel zur numerischen ID, die alle uebrigen Tools verlangen. Fuer den
  Anwender sah der Dienst aus wie defekt: Tools waren vorhanden, aber nichts
  liess sich damit anfangen. "core" wird nun beim Anlegen und Aendern eines
  Zugangs immer ergaenzt und steht dabei an erster Stelle, damit es bei
  Client-Plattformen mit Tool-Obergrenze nicht hinten wegfaellt. Bereits
  bestehende Zugaenge werden beim naechsten Aufruf geheilt — ohne Zutun.
- Im Dashboard ist "Kern" entsprechend fest gesetzt und als "immer aktiv"
  gekennzeichnet.

## [1.2.2] — 2026-09-02

### Behoben
- **Die Nutzungsseite im Dashboard brach mit einem SQL-Fehler ab.** In der
  Zeitreihe wurde die Zeiteinheit als gebundener Parameter an `date_trunc`
  uebergeben. PostgreSQL sieht dann in SELECT und GROUP BY zwei verschiedene
  Ausdruecke und weist die Abfrage zurueck (42803). Die Zeiteinheit steht nun
  als Literal im SQL, gewaehlt aus zwei fest ausgeschriebenen Varianten.
- **Sprachmodelle fanden Projekte nicht ueber Name oder Kuerzel.** Die
  Wegweisung fehlte an der Stelle, an der sie wirkt: in den Server-Instructions,
  die jeder Client im Kontext hat. Dort steht nun ausdruecklich, dass bei
  bekanntem Namen oder Kuerzel zuerst `jama_list_projects` mit `contains`
  aufzurufen ist und niemals nach einer numerischen ID gefragt werden soll,
  ohne vorher gesucht zu haben. Ebenso der Hinweis, dass eine Kennung ohne
  Item-Typ ein Projektkuerzel ist und kein Document Key.

### Hinzugefuegt
- Vier Tests, die das erzeugte SQL der Zeitreihe pruefen — ohne Datenbank, damit
  sie in jedem Lauf mitlaufen. Der Fehler war nur durchgerutscht, weil die
  Nutzungsseite im Ende-zu-Ende-Test nie aufgerufen wurde.

## [1.2.1] — 2026-09-02

### Behoben
- **Der Probelauf im Dashboard wurde nicht protokolliert.** Er ist der einzige
  Weg, ein Tool ausserhalb von MCP auszufuehren — und schreibende Tools
  veraendern dabei echte Daten. Bislang entstand dabei weder ein
  Nutzungsereignis noch ein Audit-Eintrag; damit gab es einen Weg, an der
  Nachweisfuehrung vorbei zu schreiben. Probelaeufe erscheinen nun in der
  Nutzungsauswertung (als Zugang mit dem Zusatz "Probelauf") und im Audit-Log,
  mit dem Administrator als Akteur statt des Key-Inhabers. Erfolgreiche wie
  fehlgeschlagene Laeufe werden gleichermassen erfasst.

## [1.2.0] — 2026-09-02

### Behoben
- **Verbindungstest, Key-Rotation, Loeschen, Cache leeren und Abmelden schlugen
  im Dashboard mit HTTP 400 fehl.** Die Admin-Oberflaeche setzte bei jeder
  Anfrage `Content-Type: application/json`, auch dort, wo gar keine Nutzlast
  mitging. Der Server weist eine solche Anfrage ab, weil sie einen JSON-Koerper
  ankuendigt und keinen liefert. Der Header wird nun nur noch bei tatsaechlich
  vorhandenem Body gesetzt.
- **Projekte liessen sich nicht ueber ihren Schluessel finden.** Der Filter
  `contains` in `jama_list_projects` durchsuchte ausschliesslich den Projektnamen.
  Ein Projektkuerzel — also die Kennung, die Menschen und Fremdsysteme meist
  nennen — fuehrte zu keinem Treffer, und es gab keinen Weg, daraus die interne
  numerische Projekt-ID abzuleiten, die alle uebrigen Tools verlangen. Der Filter
  durchsucht nun Name, Projektschluessel, Beschreibung und ID.

### Hinzugefuegt
- `jama_search_items` akzeptiert alternativ zur `projectId` einen `projectKey`
  und loest ihn selbst auf. Exakte Treffer gehen Teiltreffern vor; bei mehreren
  Kandidaten werden diese benannt, statt einen zu raten. Bleibt die Suche leer,
  nennt die Meldung auch fehlende Berechtigungen als moegliche Ursache.
- `docker-compose.dbnet.yml`: Override, das die Anwendung zusaetzlich an das Netz
  der Datenbank haengt. Noetig, sobald Reverse-Proxy und Datenbank in
  verschiedenen Docker-Netzen liegen — der Regelfall, wenn die Datenbank zu einem
  anderen Stack gehoert.
- 8 Tests fuer die Aufloesung von Projektkennungen.

### Geaendert
- Der `certresolver` ist in `docker-compose.traefik.yml` nicht mehr fest gesetzt.
  Viele Traefik-Installationen verwalten Zertifikate zentral und kennen gar
  keinen Resolver; ein unbekannter Name laesst den Router dort stillschweigend
  scheitern. Die Zeile steht auskommentiert bereit.

## [1.1.0] — 2026-08-12

### Hinzugefügt
- **Einzelne Tools instanzweit abschalten.** Im Tool-Katalog lässt sich jedes der
  53 Tools abschalten und wieder freigeben. Abgeschaltete Tools werden am
  MCP-Server gar nicht erst registriert und erscheinen in keinem Client —
  unabhängig davon, welche Toolsets ein Zugang hat. Damit ist etwa möglich:
  das Toolset `write` freigeben, aber `jama_delete_item` dauerhaft sperren.
  Im stdio-Betrieb über `JAMA_DISABLED_TOOLS` steuerbar.
- Neuer Guard `assertToolEnabled` als erste Prüfung in der Kette, plus
  Fehlercode `TOOL_DISABLED`.
- `docker-compose.traefik.yml` für Umgebungen, in denen Traefik und PostgreSQL
  bereits laufen — startet nur die Anwendung.
- Deployment-Anleitung für Portainer und für bestehende Infrastruktur
  ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

### Geändert
- Version auf 1.0.0 vereinheitlicht (`package.json` stand auf 0.1.0, während
  CHANGELOG und Health-Endpunkt bereits 1.0.0 meldeten).

## [1.0.0] — 2026-08-12

Erste Fassung.

### Hinzugefügt

**MCP-Server**
- 53 Tools in 8 einzeln freischaltbaren Toolsets (`core`, `trace`, `write`,
  `collab`, `test`, `history`, `review`, `files`)
- Streamable HTTP als Hauptbetriebsart, stdio für den Einzelplatz ohne Datenbank
- 5 vorgefertigte Abläufe (MCP Prompts) und 2 Resources
- Komposit-Tools, die jeweils Dutzende Einzelaufrufe ersetzen:
  `jama_trace_chain`, `jama_find_trace_gaps`, `jama_trace_matrix`,
  `jama_compare_baselines`, `jama_testcycle_summary`

**Jama-Anbindung**
- OAuth 2.0 Client Credentials mit Token-Zwischenspeicher, Basic Auth als Rückfall
- Token-Bucket je Verbindung, standardmäßig unter Jamas Grenze von 10 Anfragen
  pro Sekunde
- Wiederholung nach HTTP 429 mit Fibonacci-Backoff (3/5/8/13 Sekunden) und Streuung
- Pagination unter Beachtung der Seitengrenze von 50
- Zwischenspeicher für Stammdaten (ItemTypes, Picklists, Projekte, Benutzer)
- Aufbereitung der Antworten: HTML nach Markdown, Auflösung von Picklist-Werten
  und Benutzer-IDs, Ersetzung eingebetteter Bilder, Begrenzung auf ein Token-Budget

**Schutzschichten**
- Toolset-Prüfung, Read-only-Prüfung, Bestätigungspflicht bei löschenden Tools,
  Projekt-Allowlist
- Globale Notbremse, die alle schreibenden Tools sofort sperrt
- Trockenlauf als Standard bei Massenoperationen
- Redigieren von Geheimnissen und langen Freitexten vor dem Protokollieren

**Admin-Dashboard**
- PIN-Anmeldung mit Argon2id, IP-Sperre nach fünf Fehlversuchen, CSRF-Schutz
- Verwaltung von API-Keys inklusive Rotation, Ablauf, Deaktivierung und
  fertigem Konfigurationsschnipsel für MCP-Clients
- Verwaltung von Jama-Verbindungen mit Verbindungstest und Lizenzprüfung
- Nutzungsauswertung mit Latenzen, Fehlerquoten, Cache-Trefferquote und
  geschätztem Token-Verbrauch je Tool
- Audit-Log mit CSV-Export
- Aufruf-Explorer mit Aufwand je Tool-Aufruf
- Tool-Katalog mit Probelauf gegen eine gewählte Verbindung

**Betrieb**
- docker-compose mit nginx als einzigem Zugang von außen; Datenbank ohne
  Port-Mapping, persistente Daten in einem benannten Volume
- Mehrstufiges Dockerfile, Laufzeit ohne Build-Werkzeuge und ohne root
- Health-Checks für alle Dienste
- Migrationen laufen beim Start mit
- Stündliche Wartung: Aufbewahrungsfristen, abgelaufene Sitzungen, Cache

**Qualitätssicherung**
- 86 Tests, darunter MCDC-Matrizen für Schutzschichten, Rate-Limiter,
  Verschlüsselung und Wiederholungslogik
- End-zu-Ende-Prüfung gegen eine echte PostgreSQL

### Bekannte Einschränkungen
- Noch nicht gegen eine reale Jama-Instanz verifiziert
- Massenoperationen sind nicht atomar
- `labs`-Endpunkte (Reviews, Reports) ohne Supportzusage von Jama
- Zwischenspeicher liegt im Prozess, nicht geteilt

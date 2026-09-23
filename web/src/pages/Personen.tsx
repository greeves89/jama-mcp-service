import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, RefreshCw, Search, UserCheck, UserCog, Users } from 'lucide-react';
import { api, type Connection } from '../api';
import {
  Badge,
  Button,
  Card,
  Notice,
  Spinner,
  Stat,
  Table,
  inputClass,
  zahl,
  zeit,
} from '../components/ui';
import { StufenSchalter } from '../components/StufenSchalter';
import {
  anzeigename,
  vorWieLange,
  type Abgleichsergebnis,
  type Abgleichsstand,
  type Personenzeile,
  type Stufe,
} from '../rechte';

/**
 * Abgleich mit der Personenliste aus Jama.
 *
 * Die Seite hat zwei Aufgaben, die zusammengehoeren: den Spiegel frisch halten
 * und die Grundstufe je Person setzen. Die Grundstufe steht deshalb direkt in
 * der Zeile — bei zweihundert Personen ist der Weg ueber eine Detailseite kein
 * Weg, sondern ein Grund, es nicht zu tun.
 */
export default function PersonenPage() {
  const navigate = useNavigate();

  const [personen, setPersonen] = useState<Personenzeile[]>();
  const [listenfehler, setListenfehler] = useState<string>();
  const [laedt, setLaedt] = useState(false);

  const [q, setQ] = useState('');
  const [nurMitZuordnung, setNurMitZuordnung] = useState(false);

  const [stand, setStand] = useState<Abgleichsstand>();
  const [standGeladen, setStandGeladen] = useState(false);

  const [verbindungen, setVerbindungen] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState('');

  const [abgleichLaeuft, setAbgleichLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<Abgleichsergebnis>();
  const [abgleichHinweis, setAbgleichHinweis] = useState<string>();
  const [abgleichFehler, setAbgleichFehler] = useState<string>();
  const [alleLaeuft, setAlleLaeuft] = useState(false);
  const [alleHinweis, setAlleHinweis] = useState<string>();

  const [stufeLaeuft, setStufeLaeuft] = useState<number>();
  const [stufeFehler, setStufeFehler] = useState<string>();

  const ladePersonen = useCallback((suche: string, nurZuordnung: boolean) => {
    setLaedt(true);
    api
      .personen({ q: suche, nurMitZuordnung: nurZuordnung })
      .then((antwort) => {
        setPersonen(antwort.personen);
        setListenfehler(undefined);
      })
      .catch((error: unknown) =>
        setListenfehler(error instanceof Error ? error.message : 'Liste konnte nicht geladen werden'),
      )
      .finally(() => setLaedt(false));
  }, []);

  const ladeStand = useCallback(() => {
    api
      .abgleichsstand()
      .then(setStand)
      .catch(() => setStand(undefined))
      .finally(() => setStandGeladen(true));
  }, []);

  useEffect(() => {
    ladeStand();
    api
      .connections()
      .then((liste) => {
        setVerbindungen(liste);
        setConnectionId((vorher) => vorher || liste[0]?.id || '');
      })
      .catch(() => undefined);
  }, [ladeStand]);

  // Die Suche laeuft verzoegert, damit nicht jeder Tastendruck eine Anfrage
  // ausloest. Beim ersten Durchlauf greift die Verzoegerung ebenfalls — 250 ms
  // fallen beim Seitenaufbau nicht ins Gewicht.
  useEffect(() => {
    const timer = setTimeout(() => ladePersonen(q, nurMitZuordnung), 250);
    return () => clearTimeout(timer);
  }, [q, nurMitZuordnung, ladePersonen]);

  const laeuftImHintergrund = stand?.laeuft === true;
  const liefVorher = useRef(false);

  useEffect(() => {
    if (!laeuftImHintergrund) return;
    // Laeuft der Abgleich laenger als die Antwort offen blieb, fuehrt die Seite
    // den Stand nach, statt den Benutzer raten zu lassen, ob noch etwas
    // passiert.
    const timer = setInterval(ladeStand, 5000);
    return () => clearInterval(timer);
  }, [laeuftImHintergrund, ladeStand]);

  useEffect(() => {
    if (liefVorher.current && !laeuftImHintergrund) ladePersonen(q, nurMitZuordnung);
    liefVorher.current = laeuftImHintergrund;
  }, [laeuftImHintergrund, ladePersonen, q, nurMitZuordnung]);

  const abgleichen = async () => {
    setAbgleichLaeuft(true);
    setAbgleichFehler(undefined);
    setErgebnis(undefined);
    setAbgleichHinweis(undefined);
    try {
      const antwort = await api.abgleichAnstossen(connectionId || undefined);
      setErgebnis(antwort.ergebnis ?? undefined);
      setAbgleichHinweis(antwort.hinweis ?? undefined);
      ladeStand();
      ladePersonen(q, nurMitZuordnung);
    } catch (error) {
      setAbgleichFehler(error instanceof Error ? error.message : 'Abgleich fehlgeschlagen');
    } finally {
      setAbgleichLaeuft(false);
    }
  };

  /**
   * Setzt die Grundstufe fuer alle aktiven Personen auf einmal.
   *
   * Eine Person ohne Eintrag gilt als "keine". Wer die Matrix fuer einen Zugang
   * einschaltet, blendet damit zunaechst jeden aus — dieser Knopf ist der
   * uebliche erste Griff danach. Deshalb die Rueckfrage: Er ueberschreibt auch
   * bereits gesetzte Grundstufen.
   */
  const alleSetzen = async (stufe: Stufe) => {
    const bestaetigt = window.confirm(
      stufe === 'keine'
        ? 'Allen aktiven Personen die Grundstufe entziehen? Bereits gesetzte Grundstufen werden überschrieben. Ausdrücklich zugeordnete Projekte bleiben bestehen.'
        : `Allen aktiven Personen die Grundstufe „${stufe}" geben? Bereits gesetzte Grundstufen werden überschrieben.`,
    );
    if (!bestaetigt) return;

    setAlleLaeuft(true);
    setAlleHinweis(undefined);
    setStufeFehler(undefined);
    try {
      const antwort = await api.setzeGrundstufeFuerAlle(stufe);
      setAlleHinweis(
        antwort.betroffene === 0
          ? 'Es gibt keine aktiven Personen — bitte zuerst abgleichen.'
          : `${antwort.betroffene} Personen stehen jetzt auf „${stufe}".`,
      );
      ladePersonen(q, nurMitZuordnung);
    } catch (error) {
      setStufeFehler(
        error instanceof Error
          ? `Die Grundstufe ließ sich nicht für alle setzen: ${error.message}`
          : 'Die Grundstufe ließ sich nicht für alle setzen.',
      );
    } finally {
      setAlleLaeuft(false);
    }
  };

  const grundstufeSetzen = async (person: Personenzeile, stufe: Stufe) => {
    if (stufe === person.grundstufe) return;
    const vorher = personen ?? [];
    setStufeLaeuft(person.jamaUserId);
    setStufeFehler(undefined);
    // Sofort umschalten: die Zeile soll beim Durchklicken nicht flackern. Bei
    // einem Fehler wird der alte Stand zurueckgeschrieben.
    setPersonen(
      vorher.map((eintrag) =>
        eintrag.jamaUserId === person.jamaUserId ? { ...eintrag, grundstufe: stufe } : eintrag,
      ),
    );
    try {
      await api.setzeGrundstufe(person.jamaUserId, stufe);
    } catch (error) {
      setPersonen(vorher);
      setStufeFehler(
        error instanceof Error
          ? `Grundstufe für ${anzeigename(person)} nicht gespeichert: ${error.message}`
          : `Grundstufe für ${anzeigename(person)} nicht gespeichert.`,
      );
    } finally {
      setStufeLaeuft(undefined);
    }
  };

  const nieAbgeglichen = standGeladen && (stand === undefined || stand.am === null);
  const gefiltert = q.trim() !== '' || nurMitZuordnung;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Personen</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Spiegel der Jama-Benutzer. Die Grundstufe gilt für alle Projekte, zu denen es keine
            ausdrückliche Zuordnung gibt.
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {!standGeladen ? (
              'Stand des letzten Abgleichs wird geladen'
            ) : nieAbgeglichen ? (
              <span className="text-amber-600 dark:text-amber-400">
                Noch nie abgeglichen — oben anstoßen.
              </span>
            ) : (
              <>
                zuletzt abgeglichen {vorWieLange(stand!.am) ?? 'unbekannt'} ({zeit(stand!.am)}) ·{' '}
                {zahl(stand!.benutzer)} Benutzer · {zahl(stand!.projekte)} Projekte
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {verbindungen.length > 1 && (
            <select
              className={`${inputClass} w-56`}
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
              aria-label="Jama-Verbindung für den Abgleich"
              disabled={abgleichLaeuft}
            >
              {verbindungen.map((verbindung) => (
                <option key={verbindung.id} value={verbindung.id}>
                  {verbindung.name}
                  {verbindung.isProduction ? ' (produktiv)' : ''}
                </option>
              ))}
            </select>
          )}
          <Button
            onClick={() => void abgleichen()}
            disabled={abgleichLaeuft || laeuftImHintergrund || verbindungen.length === 0}
            title="Benutzer und Projekte aus Jama neu einlesen"
          >
            <RefreshCw
              size={14}
              className={abgleichLaeuft || laeuftImHintergrund ? 'animate-spin' : undefined}
            />
            {abgleichLaeuft || laeuftImHintergrund ? 'Abgleich läuft' : 'Abgleich anstoßen'}
          </Button>
          {/*
            Der uebliche erste Griff nach dem ersten Abgleich. Ohne ihn muesste
            jede Zeile einzeln angeklickt werden, bevor die Matrix benutzbar
            wird — bei zweihundert Personen der sichere Weg dahin, dass sie nie
            eingeschaltet wird.
          */}
          <Button
            variant="secondary"
            onClick={() => void alleSetzen('lesen')}
            disabled={alleLaeuft || abgleichLaeuft || (personen?.length ?? 0) === 0}
            title="Allen aktiven Personen die Grundstufe „lesen“ geben"
          >
            <UserCheck size={14} className={alleLaeuft ? 'animate-pulse' : undefined} />
            {alleLaeuft ? 'Wird gesetzt' : 'Alle auf Lesen'}
          </Button>
        </div>
      </header>

      {alleHinweis && <Notice tone="info">{alleHinweis}</Notice>}

      {verbindungen.length === 0 && (
        <Notice tone="warn">
          Es ist keine Jama-Verbindung angelegt. Der Abgleich holt Benutzer und Projekte über eine
          Verbindung — lege zuerst unter „Verbindungen" eine an.
        </Notice>
      )}

      {abgleichLaeuft && (
        <Card>
          <Spinner label="Benutzer und Projekte werden aus Jama gelesen. Das dauert bei großen Instanzen einen Moment." />
        </Card>
      )}

      {abgleichFehler && <Notice tone="bad">{abgleichFehler}</Notice>}

      {abgleichHinweis && !abgleichFehler && <Notice tone="info">{abgleichHinweis}</Notice>}

      {laeuftImHintergrund && !abgleichLaeuft && (
        <Notice tone="info">
          Es läuft gerade ein Abgleich. Die Seite führt den Stand selbstständig nach, sobald er
          fertig ist.
        </Notice>
      )}

      {ergebnis && !abgleichLaeuft && (
        <Card
          title="Ergebnis des Abgleichs"
          action={
            <Button variant="secondary" onClick={() => setErgebnis(undefined)}>
              Ausblenden
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Benutzer neu"
              value={zahl(ergebnis.benutzer.neu)}
              tone={ergebnis.benutzer.neu > 0 ? 'good' : 'neutral'}
            />
            <Stat label="Benutzer geändert" value={zahl(ergebnis.benutzer.geaendert)} />
            <Stat
              label="Benutzer verschwunden"
              value={zahl(ergebnis.benutzer.verschwunden)}
              tone={ergebnis.benutzer.verschwunden > 0 ? 'warn' : 'neutral'}
              hint="bleiben als deaktiviert stehen"
            />
            <Stat
              label="Dauer"
              value={`${(ergebnis.dauerMs / 1000).toFixed(1)} s`}
              hint="für Benutzer und Projekte zusammen"
            />
            <Stat
              label="Projekte neu"
              value={zahl(ergebnis.projekte.neu)}
              tone={ergebnis.projekte.neu > 0 ? 'good' : 'neutral'}
            />
            <Stat label="Projekte geändert" value={zahl(ergebnis.projekte.geaendert)} />
            <Stat
              label="Projekte verschwunden"
              value={zahl(ergebnis.projekte.verschwunden)}
              tone={ergebnis.projekte.verschwunden > 0 ? 'warn' : 'neutral'}
            />
            <Stat label="Warnungen" value={zahl(ergebnis.warnungen.length)} tone={ergebnis.warnungen.length > 0 ? 'warn' : 'good'} />
          </div>

          {ergebnis.warnungen.length > 0 && (
            <div className="mt-4">
              <Notice tone="warn">
                <div className="font-medium">Der Abgleich ist durchgelaufen, aber nicht glatt:</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {ergebnis.warnungen.map((warnung, index) => (
                    <li key={index}>{warnung}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}
        </Card>
      )}

      {stufeFehler && <Notice tone="bad">{stufeFehler}</Notice>}

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[16rem] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              className={`${inputClass} pl-8`}
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Name, Anmeldename oder E-Mail"
              aria-label="Personen durchsuchen"
              type="search"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={nurMitZuordnung}
              onChange={(event) => setNurMitZuordnung(event.target.checked)}
            />
            nur mit Zuordnung
          </label>
          {laedt && personen !== undefined && (
            <span className="text-xs text-slate-500 dark:text-slate-400">wird aktualisiert</span>
          )}
        </div>

        {listenfehler && personen === undefined ? (
          <Notice tone="bad">{listenfehler}</Notice>
        ) : personen === undefined ? (
          <Spinner />
        ) : personen.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            <Users size={22} className="mx-auto mb-2 text-slate-400" />
            {nieAbgeglichen ? (
              <p>Noch nie abgeglichen — oben anstoßen, dann steht die Personenliste hier.</p>
            ) : gefiltert ? (
              <p>
                Keine Person passt zu dieser Suche. Suchtext leeren oder den Filter „nur mit
                Zuordnung" abwählen.
              </p>
            ) : (
              <p>
                Der letzte Abgleich hat keine Benutzer geliefert. Prüfe die Jama-Verbindung und stoße
                den Abgleich erneut an.
              </p>
            )}
          </div>
        ) : (
          <>
            {listenfehler && <Notice tone="warn">{listenfehler}</Notice>}
            <Table
              kopf={[
                'Name',
                'Anmeldename',
                'E-Mail',
                'Lizenz',
                'Grundstufe',
                'Projekte',
                '',
              ]}
            >
              {personen.map((person) => (
                <tr
                  key={person.jamaUserId}
                  onClick={() => navigate(`/zuordnung?person=${person.jamaUserId}`)}
                  className={`cursor-pointer transition hover:bg-slate-50 dark:hover:bg-slate-800/60 ${
                    person.aktiv ? '' : 'bg-slate-50/60 text-slate-400 dark:bg-slate-900/40 dark:text-slate-500'
                  }`}
                >
                  <td className="px-2 py-2">
                    <div className={`font-medium ${person.aktiv ? '' : 'line-through'}`}>
                      {anzeigename(person)}
                    </div>
                    {!person.aktiv && (
                      <Badge tone="neutral">in Jama deaktiviert</Badge>
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    <code>{person.username ?? '—'}</code>
                  </td>
                  <td className="px-2 py-2 text-xs">{person.email ?? '—'}</td>
                  <td className="px-2 py-2">
                    <Badge tone={person.licenseType === 'CREATOR' ? 'info' : 'neutral'}>
                      {person.licenseType ?? 'unbekannt'}
                    </Badge>
                  </td>
                  <td
                    className="px-2 py-2"
                    // Der Schalter gehoert zur Zeile, soll aber nicht zur
                    // Zuordnungsseite springen — sonst waere das Durchklicken
                    // der Grundstufe unmoeglich.
                    onClick={(event) => event.stopPropagation()}
                  >
                    <StufenSchalter
                      wert={person.grundstufe}
                      disabled={stufeLaeuft === person.jamaUserId}
                      beschriftung={`Grundstufe für ${anzeigename(person)}`}
                      onWechsel={(stufe) => void grundstufeSetzen(person, stufe)}
                    />
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {person.anzahlZuordnungen > 0 ? (
                      zahl(person.anzahlZuordnungen)
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">0</span>
                    )}
                  </td>
                  <td className="px-2 py-2" onClick={(event) => event.stopPropagation()}>
                    <div className="flex justify-end">
                      <Button
                        variant="secondary"
                        onClick={() => navigate(`/zuordnung?person=${person.jamaUserId}`)}
                        title={`Zuordnung von ${anzeigename(person)} bearbeiten`}
                      >
                        <UserCog size={13} />
                        Zuordnung
                        <ArrowRight size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Card>
    </div>
  );
}

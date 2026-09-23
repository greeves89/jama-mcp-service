import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  FolderTree,
  Save,
  Search,
  Undo2,
  UserRound,
} from 'lucide-react';
import { api } from '../api';
import {
  Badge,
  Button,
  Card,
  Notice,
  Spinner,
  Table,
  inputClass,
  zahl,
} from '../components/ui';
import { StufenSchalter } from '../components/StufenSchalter';
import {
  anzeigename,
  baueBaum,
  geltendeStufe,
  projektname,
  stufeLabel,
  teilbaumIds,
  type PersonMitZuordnung,
  type Personenzeile,
  type Projektknoten,
  type Projektzeile,
  type Stufe,
} from '../rechte';

/**
 * Rechtezuordnung: links die Person, rechts der Projektbaum.
 *
 * Die Seite haelt die Zuordnung als Entwurf im Browser und schreibt sie erst
 * auf Knopfdruck in einem Zug. Jede einzelne Umstellung sofort zu senden waere
 * bei einem Ordner mit hundert Projekten hundert Anfragen — und ein halb
 * durchgelaufener Stapel waere schlimmer als gar keiner.
 *
 * Der Entwurf enthaelt nur die **ausdruecklichen** Zuordnungen. Alles andere
 * folgt der Grundstufe der Person; deshalb wird im Baum unterschieden, was
 * geerbt ist und was gesetzt wurde.
 */
export default function ZuordnungPage() {
  const [sucheParams, setSucheParams] = useSearchParams();
  const gewaehlteIdRoh = Number.parseInt(sucheParams.get('person') ?? '', 10);
  const gewaehlteId = Number.isFinite(gewaehlteIdRoh) ? gewaehlteIdRoh : undefined;

  const [personen, setPersonen] = useState<Personenzeile[]>();
  const [personenFehler, setPersonenFehler] = useState<string>();
  const [personensuche, setPersonensuche] = useState('');

  const [projekte, setProjekte] = useState<Projektzeile[]>();
  const [projekteFehler, setProjekteFehler] = useState<string>();

  const [detail, setDetail] = useState<PersonMitZuordnung>();
  const [detailFehler, setDetailFehler] = useState<string>();
  const [detailLaedt, setDetailLaedt] = useState(false);

  const [grundstufe, setGrundstufe] = useState<Stufe>('keine');
  const [grundstufeLaeuft, setGrundstufeLaeuft] = useState(false);

  const [ausgangslage, setAusgangslage] = useState<Map<number, Stufe>>(new Map());
  const [entwurf, setEntwurf] = useState<Map<number, Stufe>>(new Map());

  const [offen, setOffen] = useState<Set<number>>(new Set());
  const [projektsuche, setProjektsuche] = useState('');
  const [nurZugeordnete, setNurZugeordnete] = useState(false);

  const [speichert, setSpeichert] = useState(false);
  const [speicherFehler, setSpeicherFehler] = useState<string>();
  const [gespeichert, setGespeichert] = useState(false);
  const [grundstufenkonflikt, setGrundstufenkonflikt] = useState(false);

  // --- Laden ----------------------------------------------------------------

  const ladePersonen = useCallback((suche: string) => {
    api
      .personen({ q: suche })
      .then((antwort) => {
        setPersonen(antwort.personen);
        setPersonenFehler(undefined);
      })
      .catch((error: unknown) =>
        setPersonenFehler(
          error instanceof Error ? error.message : 'Personenliste konnte nicht geladen werden',
        ),
      );
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => ladePersonen(personensuche), 250);
    return () => clearTimeout(timer);
  }, [personensuche, ladePersonen]);

  useEffect(() => {
    api
      .projekte()
      .then((antwort) => {
        setProjekte(antwort.projekte);
        setProjekteFehler(undefined);
      })
      .catch((error: unknown) =>
        setProjekteFehler(
          error instanceof Error ? error.message : 'Projektbaum konnte nicht geladen werden',
        ),
      );
  }, []);

  useEffect(() => {
    if (gewaehlteId === undefined) {
      setDetail(undefined);
      setAusgangslage(new Map());
      setEntwurf(new Map());
      return;
    }
    setDetailLaedt(true);
    setDetailFehler(undefined);
    setGespeichert(false);
    setGrundstufenkonflikt(false);
    api
      .person(gewaehlteId)
      .then((antwort) => {
        setDetail(antwort);
        setGrundstufe(antwort.grundstufe);
        const stand = new Map<number, Stufe>();
        for (const projectId of antwort.lesen) stand.set(projectId, 'lesen');
        // Schreiben nach Lesen, damit ein Projekt in beiden Listen als die
        // weitergehende Stufe erscheint statt als die engere.
        for (const projectId of antwort.schreiben) stand.set(projectId, 'schreiben');
        setAusgangslage(stand);
        setEntwurf(new Map(stand));
      })
      .catch((error: unknown) =>
        setDetailFehler(error instanceof Error ? error.message : 'Person konnte nicht geladen werden'),
      )
      .finally(() => setDetailLaedt(false));
  }, [gewaehlteId]);

  // --- Entwurf --------------------------------------------------------------

  const aenderungen = useMemo(() => {
    const ids = new Set<number>([...ausgangslage.keys(), ...entwurf.keys()]);
    const liste: Array<{ projectId: number; vorher: Stufe; nachher: Stufe }> = [];
    for (const id of ids) {
      const vorher = ausgangslage.get(id) ?? 'keine';
      const nachher = entwurf.get(id) ?? 'keine';
      if (vorher !== nachher) liste.push({ projectId: id, vorher, nachher });
    }
    return liste;
  }, [ausgangslage, entwurf]);

  const offeneAenderungen = aenderungen.length > 0;

  // Ein Neuladen oder Schliessen des Tabs soll den Entwurf nicht lautlos
  // verschlucken. Innerhalb der Anwendung uebernimmt das die Rueckfrage beim
  // Wechsel der Person.
  useEffect(() => {
    if (!offeneAenderungen) return;
    const warnen = (ereignis: BeforeUnloadEvent) => {
      ereignis.preventDefault();
      ereignis.returnValue = '';
    };
    window.addEventListener('beforeunload', warnen);
    return () => window.removeEventListener('beforeunload', warnen);
  }, [offeneAenderungen]);

  const waehlePerson = (jamaUserId: number) => {
    if (jamaUserId === gewaehlteId) return;
    if (
      offeneAenderungen &&
      !confirm(
        `Es gibt ${aenderungen.length} ungespeicherte Änderung(en). Beim Wechsel der Person gehen sie verloren. Trotzdem wechseln?`,
      )
    ) {
      return;
    }
    setSucheParams({ person: String(jamaUserId) });
  };

  /**
   * Setzt eine Stufe fuer eine oder viele Projektnummern.
   *
   * Die Stufe „keine" loescht die ausdrueckliche Zuordnung, statt sie als
   * Verbot zu speichern — ein Verbot kennt das Datenmodell nicht. Steht die
   * Grundstufe auf lesen oder schreiben, bleibt das Projekt deshalb sichtbar;
   * darauf weist die Seite ausdruecklich hin, statt einen Klick ins Leere
   * laufen zu lassen.
   */
  const setzeStufe = (ids: number[], stufe: Stufe) => {
    setEntwurf((vorher) => {
      const neu = new Map(vorher);
      for (const id of ids) {
        if (stufe === 'keine' || stufe === grundstufe) neu.delete(id);
        else neu.set(id, stufe);
      }
      return neu;
    });
    setGespeichert(false);
    if (stufe === 'keine' && grundstufe !== 'keine') setGrundstufenkonflikt(true);
  };

  const grundstufeSetzen = async (stufe: Stufe) => {
    if (gewaehlteId === undefined || stufe === grundstufe) return;
    const vorher = grundstufe;
    setGrundstufe(stufe);
    setGrundstufeLaeuft(true);
    setSpeicherFehler(undefined);
    if (stufe === 'keine') setGrundstufenkonflikt(false);
    try {
      await api.setzeGrundstufe(gewaehlteId, stufe);
      setPersonen((liste) =>
        liste?.map((eintrag) =>
          eintrag.jamaUserId === gewaehlteId ? { ...eintrag, grundstufe: stufe } : eintrag,
        ),
      );
    } catch (error) {
      setGrundstufe(vorher);
      setSpeicherFehler(
        error instanceof Error
          ? `Grundstufe nicht gespeichert: ${error.message}`
          : 'Grundstufe nicht gespeichert.',
      );
    } finally {
      setGrundstufeLaeuft(false);
    }
  };

  const verwerfen = () => {
    setEntwurf(new Map(ausgangslage));
    setGespeichert(false);
    setGrundstufenkonflikt(false);
  };

  const speichern = async () => {
    if (gewaehlteId === undefined) return;
    setSpeichert(true);
    setSpeicherFehler(undefined);
    // Mitgeschickt wird der vollstaendige Satz ausdruecklicher Zuordnungen,
    // dazu die entfallenen als „keine". So ist der Aufruf unabhaengig davon
    // richtig, ob der Dienst ersetzt oder einzeln nachfuehrt.
    const eintraege: Array<{ projectId: number; stufe: Stufe }> = [
      ...[...entwurf.entries()].map(([projectId, stufe]) => ({ projectId, stufe })),
      ...[...ausgangslage.keys()]
        .filter((projectId) => !entwurf.has(projectId))
        .map((projectId) => ({ projectId, stufe: 'keine' as Stufe })),
    ];
    try {
      await api.setzeZuordnung(gewaehlteId, eintraege);
      setAusgangslage(new Map(entwurf));
      setGespeichert(true);
      const anzahl = entwurf.size;
      setPersonen((liste) =>
        liste?.map((eintrag) =>
          eintrag.jamaUserId === gewaehlteId ? { ...eintrag, anzahlZuordnungen: anzahl } : eintrag,
        ),
      );
    } catch (error) {
      setSpeicherFehler(
        error instanceof Error ? `Speichern fehlgeschlagen: ${error.message}` : 'Speichern fehlgeschlagen.',
      );
    } finally {
      setSpeichert(false);
    }
  };

  // --- Baum -----------------------------------------------------------------

  const baum = useMemo(() => baueBaum(projekte ?? []), [projekte]);

  useEffect(() => {
    // Beim ersten Laden stehen nur die obersten Ordner offen. Alles andere
    // aufzuklappen waere bei mehreren hundert Projekten eine Wand aus Zeilen.
    setOffen(new Set(baum.filter((knoten) => knoten.kinder.length > 0).map((knoten) => knoten.projekt.jamaProjectId)));
  }, [baum]);

  const passt = useCallback(
    (projekt: Projektzeile) => {
      const text = projektsuche.trim().toLowerCase();
      if (text === '') return true;
      return (
        projektname(projekt).toLowerCase().includes(text) ||
        (projekt.projectKey ?? '').toLowerCase().includes(text) ||
        String(projekt.jamaProjectId).includes(text)
      );
    },
    [projektsuche],
  );

  /**
   * Nummern aller Knoten, die angezeigt werden: die Treffer selbst und ihre
   * Ordner darueber. Ohne die Ordner haengt ein Treffer in der Luft und die
   * Einrueckung wird unlesbar.
   */
  const sichtbar = useMemo(() => {
    const filternAktiv = projektsuche.trim() !== '' || nurZugeordnete;
    if (!filternAktiv) return null;

    const erlaubt = new Set<number>();
    const pruefe = (knoten: Projektknoten): boolean => {
      const zugeordnet = !nurZugeordnete || entwurf.has(knoten.projekt.jamaProjectId);
      const selbst = passt(knoten.projekt) && zugeordnet;
      let kindTreffer = false;
      for (const kind of knoten.kinder) if (pruefe(kind)) kindTreffer = true;
      if (selbst || kindTreffer) {
        erlaubt.add(knoten.projekt.jamaProjectId);
        return true;
      }
      return false;
    };
    for (const wurzel of baum) pruefe(wurzel);
    return erlaubt;
  }, [baum, passt, projektsuche, nurZugeordnete, entwurf]);

  const sichtbareZeilen = useMemo(() => {
    const zeilen: Projektknoten[] = [];
    const sammle = (knoten: Projektknoten[]) => {
      for (const eintrag of knoten) {
        const id = eintrag.projekt.jamaProjectId;
        if (sichtbar && !sichtbar.has(id)) continue;
        zeilen.push(eintrag);
        // Bei aktivem Filter sind die Aeste offen: sonst blieben die gefundenen
        // Projekte hinter zugeklappten Ordnern verborgen.
        const aufgeklappt = sichtbar !== null || offen.has(id);
        if (eintrag.kinder.length > 0 && aufgeklappt) sammle(eintrag.kinder);
      }
    };
    sammle(baum);
    return zeilen;
  }, [baum, offen, sichtbar]);

  const alleOrdnerIds = useMemo(() => {
    const ids: number[] = [];
    const gehe = (knoten: Projektknoten[]) => {
      for (const eintrag of knoten) {
        if (eintrag.kinder.length > 0) ids.push(eintrag.projekt.jamaProjectId);
        gehe(eintrag.kinder);
      }
    };
    gehe(baum);
    return ids;
  }, [baum]);

  const umschalten = (id: number) =>
    setOffen((vorher) => {
      const neu = new Set(vorher);
      if (neu.has(id)) neu.delete(id);
      else neu.add(id);
      return neu;
    });

  const gewaehltePerson = personen?.find((eintrag) => eintrag.jamaUserId === gewaehlteId);
  const personName = detail ? anzeigename(detail.person) : gewaehltePerson ? anzeigename(gewaehltePerson) : undefined;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Rechtezuordnung</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Wer darf welches Projekt lesen oder ändern. Die Zuordnung kann nie mehr erlauben als die
          Projektfreigabe des verwendeten Zugangs — sie schränkt innerhalb dieser Grenze weiter ein.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Card title="Person">
          <div className="relative mb-3">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              className={`${inputClass} pl-8`}
              value={personensuche}
              onChange={(event) => setPersonensuche(event.target.value)}
              placeholder="Name oder Anmeldename"
              aria-label="Personen durchsuchen"
              type="search"
            />
          </div>

          {personenFehler && personen === undefined ? (
            <Notice tone="bad">{personenFehler}</Notice>
          ) : personen === undefined ? (
            <Spinner />
          ) : personen.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              {personensuche.trim() === ''
                ? 'Noch keine Personen im Spiegel — unter „Personen" den Abgleich anstoßen.'
                : 'Keine Person passt zu dieser Suche.'}
            </p>
          ) : (
            <ul className="max-h-[32rem] space-y-0.5 overflow-y-auto pr-1">
              {personen.map((person) => {
                const aktivZeile = person.jamaUserId === gewaehlteId;
                return (
                  <li key={person.jamaUserId}>
                    <button
                      type="button"
                      onClick={() => waehlePerson(person.jamaUserId)}
                      aria-current={aktivZeile ? 'true' : undefined}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                        aktivZeile
                          ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                          : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span className={`block font-medium ${person.aktiv ? '' : 'line-through opacity-70'}`}>
                        {anzeigename(person)}
                      </span>
                      <span
                        className={`block text-xs ${
                          aktivZeile ? 'opacity-80' : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {person.username ?? `Nummer ${person.jamaUserId}`} · Grundstufe{' '}
                        {stufeLabel(person.grundstufe)} · {zahl(person.anzahlZuordnungen)} Projekte
                        {person.aktiv ? '' : ' · deaktiviert'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          {gewaehlteId === undefined ? (
            <Card>
              <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                <UserRound size={22} className="mx-auto mb-2 text-slate-400" />
                <p>
                  Links eine Person wählen. Rechts erscheint dann der Projektbaum mit je drei
                  Stufen: keine, lesen, schreiben.
                </p>
              </div>
            </Card>
          ) : detailFehler ? (
            <Notice tone="bad">{detailFehler}</Notice>
          ) : detailLaedt || detail === undefined ? (
            <Card>
              <Spinner label="Zuordnung wird geladen" />
            </Card>
          ) : (
            <>
              <Card title={`Grundstufe für ${personName ?? 'diese Person'}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <StufenSchalter
                    wert={grundstufe}
                    disabled={grundstufeLaeuft}
                    beschriftung="Grundstufe dieser Person"
                    onWechsel={(stufe) => void grundstufeSetzen(stufe)}
                  />
                  <p className="flex-1 text-xs text-slate-500 dark:text-slate-400">
                    Gilt für jedes Projekt ohne ausdrückliche Zuordnung. Sie wird sofort gespeichert
                    — unabhängig vom Entwurf im Baum darunter.
                  </p>
                </div>
                {!detail.person.aktiv && (
                  <div className="mt-3">
                    <Notice tone="warn">
                      Diese Person ist in Jama deaktiviert. Ihre Zuordnung bleibt bestehen und wirkt
                      weiter, sobald das Konto wieder aktiv ist.
                    </Notice>
                  </div>
                )}
                {grundstufenkonflikt && grundstufe !== 'keine' && (
                  <div className="mt-3">
                    <Notice tone="warn">
                      <div>
                        Die Grundstufe „{stufeLabel(grundstufe)}" gilt für alle Projekte ohne
                        ausdrückliche Zuordnung. Einzelne Projekte lassen sich davon nicht
                        ausnehmen — setze die Grundstufe auf „keine", wenn nur die ausdrücklich
                        gewählten Projekte gelten sollen.
                      </div>
                      <div className="mt-2">
                        <Button variant="secondary" onClick={() => void grundstufeSetzen('keine')}>
                          Grundstufe auf „keine" setzen
                        </Button>
                      </div>
                    </Notice>
                  </div>
                )}
              </Card>

              {speicherFehler && <Notice tone="bad">{speicherFehler}</Notice>}
              {gespeichert && !offeneAenderungen && (
                <Notice tone="good">Die Zuordnung ist gespeichert.</Notice>
              )}

              <Card
                title="Projektbaum"
                action={
                  <div className="flex items-center gap-1">
                    <Button
                      variant="secondary"
                      onClick={() => setOffen(new Set(alleOrdnerIds))}
                      disabled={alleOrdnerIds.length === 0}
                      title="Alle Ordner aufklappen"
                    >
                      <ChevronDown size={13} />
                      Alle auf
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setOffen(new Set())}
                      disabled={alleOrdnerIds.length === 0}
                      title="Alle Ordner zuklappen"
                    >
                      <ChevronRight size={13} />
                      Alle zu
                    </Button>
                  </div>
                }
              >
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <div className="relative min-w-[14rem] flex-1">
                    <Search
                      size={14}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      className={`${inputClass} pl-8`}
                      value={projektsuche}
                      onChange={(event) => setProjektsuche(event.target.value)}
                      placeholder="Projektname, Schlüssel oder Nummer"
                      aria-label="Projekte durchsuchen"
                      type="search"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={nurZugeordnete}
                      onChange={(event) => setNurZugeordnete(event.target.checked)}
                    />
                    nur ausdrücklich zugeordnete
                  </label>
                </div>

                {projekteFehler && projekte === undefined ? (
                  <Notice tone="bad">{projekteFehler}</Notice>
                ) : projekte === undefined ? (
                  <Spinner label="Projektbaum wird geladen" />
                ) : projekte.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                    <FolderTree size={22} className="mx-auto mb-2 text-slate-400" />
                    <p>
                      Der Spiegel enthält keine Projekte. Unter „Personen" den Abgleich anstoßen —
                      er holt Benutzer und Projekte zusammen.
                    </p>
                  </div>
                ) : sichtbareZeilen.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                    Kein Projekt passt zu dieser Suche oder zum Filter.
                  </p>
                ) : (
                  <Table kopf={['Projekt', 'Nummer', 'Herkunft', 'Stufe']}>
                    {sichtbareZeilen.map((knoten) => {
                      const projekt = knoten.projekt;
                      const id = projekt.jamaProjectId;
                      const { stufe, geerbt } = geltendeStufe(id, entwurf, grundstufe);
                      const istOrdner = knoten.kinder.length > 0 || projekt.istOrdner;
                      const aufgeklappt = sichtbar !== null || offen.has(id);
                      const geaendert = (ausgangslage.get(id) ?? 'keine') !== (entwurf.get(id) ?? 'keine');

                      return (
                        <tr
                          key={id}
                          className={`${geaendert ? 'bg-sky-50/70 dark:bg-sky-950/30' : ''} ${
                            projekt.archiviert ? 'text-slate-400 dark:text-slate-500' : ''
                          }`}
                        >
                          <td className="px-2 py-1.5">
                            <div
                              className="flex items-center gap-1"
                              style={{ paddingLeft: `${knoten.tiefe * 16}px` }}
                            >
                              {knoten.kinder.length > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => umschalten(id)}
                                  disabled={sichtbar !== null}
                                  aria-expanded={aufgeklappt}
                                  title={
                                    sichtbar !== null
                                      ? 'Bei aktiver Suche bleibt der Baum aufgeklappt'
                                      : aufgeklappt
                                        ? 'Zuklappen'
                                        : 'Aufklappen'
                                  }
                                  className="rounded p-0.5 text-slate-500 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50 dark:hover:bg-slate-800"
                                >
                                  {aufgeklappt ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </button>
                              ) : (
                                <span className="inline-block w-[22px]" />
                              )}
                              <span className={istOrdner ? 'font-medium' : ''}>
                                {projektname(projekt)}
                              </span>
                              {projekt.projectKey && (
                                <code className="text-xs text-slate-500 dark:text-slate-400">
                                  {projekt.projectKey}
                                </code>
                              )}
                              {istOrdner && <Badge tone="neutral">Ordner</Badge>}
                              {projekt.archiviert && <Badge tone="neutral">archiviert</Badge>}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                            {id}
                          </td>
                          <td className="px-2 py-1.5 text-xs">
                            {geerbt ? (
                              <span className="text-slate-500 dark:text-slate-400">
                                aus Grundstufe
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1">
                                <Badge tone="info">gesetzt</Badge>
                                <button
                                  type="button"
                                  onClick={() => setzeStufe([id], 'keine')}
                                  title="Ausdrückliche Zuordnung entfernen, damit wieder die Grundstufe gilt"
                                  className="rounded p-0.5 text-slate-500 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-800"
                                >
                                  <Undo2 size={13} />
                                </button>
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <StufenSchalter
                              wert={stufe}
                              geerbt={geerbt}
                              beschriftung={
                                istOrdner
                                  ? `Stufe für ${projektname(projekt)} und alles darunter`
                                  : `Stufe für ${projektname(projekt)}`
                              }
                              onWechsel={(neueStufe) =>
                                // Ein Ordner setzt alles darunter: ohne diese
                                // Abkuerzung waere die Seite bei mehreren
                                // hundert Projekten nicht bedienbar. Bei
                                // aktiver Suche bleibt es bei den angezeigten
                                // Zeilen — sonst aenderte ein Klick Dutzende
                                // Projekte, die gerade niemand sieht.
                                setzeStufe(
                                  istOrdner
                                    ? teilbaumIds(knoten).filter(
                                        (nummer) => sichtbar === null || sichtbar.has(nummer),
                                      )
                                    : [id],
                                  neueStufe,
                                )
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </Table>
                )}

                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Ein Ordner setzt die Stufe für alles darunter — bei aktiver Suche nur für die
                  angezeigten Zeilen. Ein gestrichelter Rahmen bedeutet: die Stufe kommt aus der
                  Grundstufe und hängt nicht an diesem Projekt.
                </p>
              </Card>
            </>
          )}
        </div>
      </div>

      {gewaehlteId !== undefined && detail !== undefined && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="text-sm">
            {offeneAenderungen ? (
              <>
                <span className="font-medium">
                  {zahl(aenderungen.length)} {aenderungen.length === 1 ? 'Zeile ändert' : 'Zeilen ändern'} sich
                </span>
                <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                  {zahl(entwurf.size)} ausdrückliche Zuordnungen nach dem Speichern
                </span>
              </>
            ) : (
              <span className="text-slate-500 dark:text-slate-400">
                Keine ungespeicherten Änderungen.
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={verwerfen} disabled={!offeneAenderungen || speichert}>
              <Undo2 size={14} />
              Verwerfen
            </Button>
            <Button onClick={() => void speichern()} disabled={!offeneAenderungen || speichert}>
              <Save size={14} />
              {speichert ? 'Wird gespeichert' : 'Zuordnung speichern'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

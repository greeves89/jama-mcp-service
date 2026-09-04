import { useEffect, useState } from 'react';
import { Eraser, KeyRound, Save, ShieldOff } from 'lucide-react';
import { api, type SettingsResponse } from '../api';
import { Button, Card, Field, Notice, Spinner, Table, inputClass, zeit } from '../components/ui';

export default function SettingsPage({ onAbgemeldet }: { onAbgemeldet: () => void }) {
  const [daten, setDaten] = useState<SettingsResponse>();
  const [fehler, setFehler] = useState<string>();
  const [meldung, setMeldung] = useState<string>();
  const [budget, setBudget] = useState('');
  const [aufbewahrung, setAufbewahrung] = useState('');
  const [neuerPin, setNeuerPin] = useState('');
  const [pinWiederholung, setPinWiederholung] = useState('');

  const laden = () => {
    api
      .settings()
      .then((antwort) => {
        setDaten(antwort);
        setBudget(String(antwort.einstellungen.responseTokenBudget));
        setAufbewahrung(String(antwort.einstellungen.usageRetentionDays));
      })
      .catch((error) => setFehler(error.message));
  };

  useEffect(laden, []);

  const herkunftUmschalten = async (aktiv: boolean) => {
    try {
      await api.updateSettings({ vermerkeHerkunft: aktiv });
      setMeldung(
        aktiv
          ? 'Änderungen werden künftig in Jama vermerkt.'
          : 'Der Herkunftsvermerk ist abgeschaltet.',
      );
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Umstellen fehlgeschlagen');
    }
  };

  const notbremse = async (aktiv: boolean) => {
    try {
      await api.updateSettings({ globalReadOnly: aktiv });
      setMeldung(
        aktiv
          ? 'Notbremse aktiviert. Alle schreibenden Tools sind ab sofort gesperrt.'
          : 'Notbremse gelöst. Schreibende Tools sind wieder gemäß den Key-Einstellungen erlaubt.',
      );
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Änderung fehlgeschlagen');
    }
  };

  const grenzenSpeichern = async () => {
    try {
      await api.updateSettings({
        responseTokenBudget: Number.parseInt(budget, 10),
        usageRetentionDays: Number.parseInt(aufbewahrung, 10),
      });
      setMeldung('Einstellungen gespeichert.');
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
    }
  };

  const pinAendern = async () => {
    if (neuerPin !== pinWiederholung) {
      setFehler('Die beiden PIN-Eingaben stimmen nicht überein.');
      return;
    }
    try {
      await api.changePin(neuerPin);
      onAbgemeldet();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'PIN-Änderung fehlgeschlagen');
    }
  };

  const cacheLeeren = async () => {
    try {
      const ergebnis = await api.clearCache();
      setMeldung(`Cache geleert: ${ergebnis.entfernteEintraege} Einträge entfernt.`);
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Leeren fehlgeschlagen');
    }
  };

  if (fehler && !daten) return <Notice tone="bad">{fehler}</Notice>;
  if (!daten) return <Spinner />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Einstellungen</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Betriebsgrenzen, Notbremse und Zugang zur Verwaltung
        </p>
      </header>

      {fehler && <Notice tone="bad">{fehler}</Notice>}
      {meldung && <Notice tone="good">{meldung}</Notice>}

      <Card title="Notbremse">
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          Sperrt alle schreibenden Tools sofort, unabhängig davon, was für die einzelnen API-Keys
          eingestellt ist. Gedacht für den Fall, dass ein Zugang auffällig wird oder eine
          Massenänderung gestoppt werden muss.
        </p>
        {daten.einstellungen.globalReadOnly ? (
          <div className="space-y-3">
            <Notice tone="warn">
              <span className="inline-flex items-center gap-1">
                <ShieldOff size={14} />
                Die Notbremse ist aktiv. Es sind derzeit nur lesende Zugriffe möglich.
              </span>
            </Notice>
            <Button variant="secondary" onClick={() => void notbremse(false)}>
              Notbremse lösen
            </Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => void notbremse(true)}>
            <ShieldOff size={14} />
            Alle Schreibzugriffe sperren
          </Button>
        )}
      </Card>

      <Card title="Nachvollziehbarkeit">
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          Vermerkt jede Änderung als Kommentar am betroffenen Item: wer sie veranlasst hat und
          über welchen Zugang. Jama führt zwar eine eigene Historie, dort steht aber nur der
          technische Benutzer dieser Anbindung — teilen sich mehrere Personen einen Zugang, ist
          im Nachhinein sonst nicht mehr feststellbar, wer eine Anforderung angelegt oder
          geändert hat.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={daten.einstellungen.vermerkeHerkunft}
            onChange={(e) => void herkunftUmschalten(e.target.checked)}
          />
          <span>
            Herkunft als Kommentar in Jama vermerken
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              Kostet einen zusätzlichen Jama-Aufruf je geändertem Item und fällt damit bei
              Massenanlagen ins Gewicht. Ist die Person nicht bekannt, wird das im Kommentar
              ausdrücklich gesagt.
            </span>
          </span>
        </label>
        {daten.einstellungen.vermerkeHerkunft && (
          <Notice tone="info">
            Der Client muss die Person mitschicken, damit sie im Kommentar erscheint. Open WebUI
            sendet dafür Kopfzeilen, sobald ENABLE_FORWARD_USER_INFO_HEADERS gesetzt ist — bei
            Anbindung über MCP werden sie derzeit allerdings noch nicht weitergereicht. Ohne die
            Angabe steht im Kommentar nur der verwendete Zugang.
          </Notice>
        )}
      </Card>

      <Card title="Betriebsgrenzen">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Antwortbudget je Tool-Aufruf (Token)"
            hint="Längere Antworten werden mit Hinweis gekürzt. Schützt das Kontextfenster des Clients."
          >
            <input
              type="number"
              min="1000"
              max="200000"
              step="1000"
              className={inputClass}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </Field>
          <Field
            label="Aufbewahrung der Nutzungsdaten (Tage)"
            hint="Der Audit-Trail ist davon nicht betroffen — er bleibt als Nachweis erhalten."
          >
            <input
              type="number"
              min="1"
              max="3650"
              className={inputClass}
              value={aufbewahrung}
              onChange={(e) => setAufbewahrung(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => void grenzenSpeichern()}>
            <Save size={14} />
            Speichern
          </Button>
          <Button variant="secondary" onClick={() => void cacheLeeren()}>
            <Eraser size={14} />
            Stammdaten-Cache leeren
          </Button>
        </div>
      </Card>

      <Card title="PIN ändern">
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          Nach der Änderung werden alle Sitzungen beendet — auch die eigene.
        </p>
        <div className="grid max-w-md gap-4">
          <Field label="Neuer PIN" hint="Mindestens acht Ziffern.">
            <input
              type="password"
              inputMode="numeric"
              className={inputClass}
              value={neuerPin}
              onChange={(e) => setNeuerPin(e.target.value)}
            />
          </Field>
          <Field label="Wiederholung">
            <input
              type="password"
              inputMode="numeric"
              className={inputClass}
              value={pinWiederholung}
              onChange={(e) => setPinWiederholung(e.target.value)}
            />
          </Field>
          <div>
            <Button onClick={() => void pinAendern()} disabled={neuerPin.length < 8}>
              <KeyRound size={14} />
              PIN ändern
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Aktive Sitzungen">
        {daten.sitzungen.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Keine aktiven Sitzungen.</p>
        ) : (
          <Table kopf={['Angemeldet', 'Zuletzt gesehen', 'Adresse']}>
            {daten.sitzungen.map((sitzung) => (
              <tr key={sitzung.id}>
                <td className="px-2 py-2 text-xs">{zeit(sitzung.angelegt)}</td>
                <td className="px-2 py-2 text-xs">{zeit(sitzung.zuletzt)}</td>
                <td className="px-2 py-2 text-xs">{sitzung.ip ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Endpunkt für MCP-Clients">
        <code className="block rounded border border-slate-300 bg-slate-50 px-3 py-2 text-xs dark:border-slate-600 dark:bg-slate-800">
          {daten.publicBaseUrl.replace(/\/+$/, '')}/mcp
        </code>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Wird beim Anlegen eines Keys automatisch in das Konfigurationsschnipsel eingesetzt. Über
          die Umgebungsvariable <code>PUBLIC_BASE_URL</code> anpassbar.
        </p>
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type UsageEventRow } from '../api';
import { Badge, Button, Card, Notice, Spinner, Table, zahl, zeit } from '../components/ui';

/**
 * Aufruf-Explorer: zeigt, was ein Tool-Aufruf tatsächlich verursacht hat —
 * wie viele Jama-Aufrufe, wie viele Cache-Treffer, wie viele Wiederholungen
 * nach Drosselung. Das wichtigste Werkzeug bei der Fehlersuche im Betrieb.
 */
export default function EventsPage() {
  const [ereignisse, setEreignisse] = useState<UsageEventRow[]>();
  const [fehler, setFehler] = useState<string>();
  const [nurFehler, setNurFehler] = useState(false);

  const laden = () => {
    api.events(200, nurFehler).then(setEreignisse).catch((error) => setFehler(error.message));
  };

  useEffect(laden, [nurFehler]);

  if (fehler) return <Notice tone="bad">{fehler}</Notice>;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Aufrufe</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Die letzten Tool-Aufrufe mit Aufwand und Ergebnis
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={nurFehler} onChange={(e) => setNurFehler(e.target.checked)} />
            Nur Fehler
          </label>
          <Button variant="secondary" onClick={laden}>
            <RefreshCw size={14} />
            Aktualisieren
          </Button>
        </div>
      </header>

      {!ereignisse ? (
        <Spinner />
      ) : (
        <Card>
          {ereignisse.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              Keine Aufrufe erfasst.
            </p>
          ) : (
            <Table
              kopf={['Zeitpunkt', 'Tool', 'Zugang', 'Dauer', 'Jama', 'Cache', 'Wdh.', 'Token', 'Status']}
            >
              {ereignisse.map((ereignis) => (
                <tr key={ereignis.id}>
                  <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-500 dark:text-slate-400">
                    {zeit(ereignis.ts)}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs">
                    {ereignis.toolName}
                    {ereignis.truncated && (
                      <span className="ml-1">
                        <Badge tone="warn">gekürzt</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs">{ereignis.apiKeyName ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums text-xs">{zahl(ereignis.durationMs)} ms</td>
                  <td className="px-2 py-2 tabular-nums text-xs">{ereignis.jamaCallCount}</td>
                  <td className="px-2 py-2 tabular-nums text-xs">{ereignis.cacheHits}</td>
                  <td className="px-2 py-2 tabular-nums text-xs">
                    {ereignis.retries > 0 ? (
                      <span className="text-amber-600">{ereignis.retries}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-xs">{zahl(ereignis.estTokens)}</td>
                  <td className="px-2 py-2">
                    {ereignis.status === 'ok' ? (
                      <Badge tone="good">ok</Badge>
                    ) : (
                      <Badge tone="bad">{ereignis.errorCode ?? 'Fehler'}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}

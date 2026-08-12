import { useEffect, useState } from 'react';
import { AlertTriangle, Database, Gauge, RefreshCw, ShieldOff } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type Overview } from '../api';
import { Badge, Button, Card, Notice, Spinner, Stat, Table, zahl, zeit } from '../components/ui';

/**
 * Uebersichtsseite.
 *
 * Die wichtigste Kachel ist die Auslastung gegen das Jama-Limit: sie ist die
 * einzige Zahl, an der sich fruehzeitig ablesen laesst, ob der Dienst die
 * Jama-Instanz fuer andere Integrationen ausbremst.
 */
export default function OverviewPage() {
  const [daten, setDaten] = useState<Overview>();
  const [fehler, setFehler] = useState<string>();
  const [verlauf, setVerlauf] = useState<Array<{ zeitpunkt: string; aufrufe: number }>>([]);

  const laden = () => {
    api.overview().then(setDaten).catch((error) => setFehler(error.message));
    api
      .usage({ from: new Date(Date.now() - 7 * 864e5).toISOString() })
      .then((bericht) =>
        setVerlauf(
          bericht.zeitreihe.map((punkt) => ({
            zeitpunkt: new Date(punkt.zeitpunkt).toLocaleDateString('de-DE', {
              day: '2-digit',
              month: '2-digit',
            }),
            aufrufe: punkt.aufrufe,
          })),
        ),
      )
      .catch(() => undefined);
  };

  useEffect(() => {
    laden();
    const timer = setInterval(laden, 30_000);
    return () => clearInterval(timer);
  }, []);

  if (fehler) return <Notice tone="bad">{fehler}</Notice>;
  if (!daten) return <Spinner />;

  const produktivVerbunden = daten.gesundheit.verbindungen.some((v) => v.produktiv);
  const woche = daten.nutzung.woche;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Übersicht</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Betriebszustand und Nutzung der letzten Tage
          </p>
        </div>
        <Button variant="secondary" onClick={laden}>
          <RefreshCw size={14} />
          Aktualisieren
        </Button>
      </header>

      {daten.einstellungen.globalReadOnly && (
        <Notice tone="warn">
          <span className="inline-flex items-center gap-1">
            <ShieldOff size={14} />
            Die globale Notbremse ist aktiv. Alle schreibenden Tools sind gesperrt, unabhängig von
            den Einstellungen der einzelnen Keys.
          </span>
        </Notice>
      )}

      {produktivVerbunden && (
        <Notice tone="warn">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle size={14} />
            Mindestens eine Verbindung zeigt auf eine Produktivinstanz. Schreibende Zugriffe wirken
            dort auf echte Projektdaten.
          </span>
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Aufrufe (7 Tage)" value={zahl(woche.aufrufe)} />
        <Stat
          label="Fehlerquote"
          value={`${woche.fehlerquote} %`}
          tone={woche.fehlerquote > 10 ? 'bad' : woche.fehlerquote > 3 ? 'warn' : 'good'}
        />
        <Stat label="Latenz p95" value={`${zahl(woche.latenzP95)} ms`} hint={`p50 ${woche.latenzP50} ms`} />
        <Stat
          label="Cache-Trefferquote"
          value={`${woche.cacheTrefferquote} %`}
          hint={`${zahl(woche.jamaAufrufe)} Jama-Aufrufe`}
          tone={woche.cacheTrefferquote > 40 ? 'good' : 'neutral'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Auslastung gegen das Jama-Limit" className="lg:col-span-1">
          {Object.keys(daten.ratenbegrenzung).length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Noch keine Aufrufe seit dem Start — die Auslastung wird erst nach dem ersten
              Jama-Zugriff sichtbar.
            </p>
          ) : (
            <div className="space-y-3">
              {Object.entries(daten.ratenbegrenzung).map(([id, bucket]) => {
                const verbindung = daten.gesundheit.verbindungen.find((v) => v.id === id);
                const genutzt = Math.max(
                  0,
                  Math.round(((bucket.capacity - bucket.availableTokens) / bucket.capacity) * 100),
                );
                return (
                  <div key={id}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
                        <Gauge size={13} />
                        {verbindung?.name ?? id.slice(0, 8)}
                      </span>
                      <span className="tabular-nums text-slate-500 dark:text-slate-400">
                        {bucket.ratePerSecond}/s
                        {bucket.waiting > 0 && ` · ${bucket.waiting} warten`}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
                      <div
                        className={`h-full transition-all ${
                          genutzt > 80 ? 'bg-red-500' : genutzt > 50 ? 'bg-amber-500' : 'bg-emerald-500'
                        }`}
                        style={{ width: `${genutzt}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              <p className="pt-1 text-xs text-slate-500 dark:text-slate-400">
                Jama drosselt bei 10 Anfragen pro Sekunde für die gesamte Instanz — das Limit gilt
                geteilt mit allen anderen Integrationen.
              </p>
            </div>
          )}
        </Card>

        <Card title="Aufrufe der letzten 7 Tage" className="lg:col-span-2">
          {verlauf.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Noch keine Aufrufe erfasst.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={verlauf}>
                <XAxis dataKey="zeitpunkt" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" width={38} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6 }}
                  labelFormatter={(wert) => `Tag ${wert}`}
                />
                <Area
                  type="monotone"
                  dataKey="aufrufe"
                  stroke="#0f172a"
                  fill="#cbd5e1"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Verbindungen">
          <div className="mb-3 flex items-center gap-2 text-sm">
            <Database size={14} className={daten.gesundheit.datenbank ? 'text-emerald-600' : 'text-red-600'} />
            <span className="text-slate-600 dark:text-slate-300">
              Datenbank {daten.gesundheit.datenbank ? 'erreichbar' : 'nicht erreichbar'}
            </span>
          </div>

          {daten.gesundheit.verbindungen.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Noch keine Jama-Verbindung angelegt.
            </p>
          ) : (
            <Table kopf={['Name', 'Status', 'Geprüft']}>
              {daten.gesundheit.verbindungen.map((verbindung) => (
                <tr key={verbindung.id}>
                  <td className="px-2 py-2">
                    {verbindung.name}
                    {verbindung.produktiv && (
                      <span className="ml-2">
                        <Badge tone="bad">Produktiv</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={verbindung.status === 'ok' ? 'good' : verbindung.status === 'error' ? 'bad' : 'neutral'}>
                      {verbindung.status}
                    </Badge>
                  </td>
                  <td className="px-2 py-2 text-slate-500 dark:text-slate-400">
                    {zeit(verbindung.geprueft)}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Meistgenutzte Tools (7 Tage)">
          {daten.topTools.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Noch keine Aufrufe.</p>
          ) : (
            <Table kopf={['Tool', 'Aufrufe', 'Fehler', 'Token', 'p95']}>
              {daten.topTools.map((tool) => (
                <tr key={tool.tool}>
                  <td className="px-2 py-2 font-mono text-xs">{tool.tool}</td>
                  <td className="px-2 py-2 tabular-nums">{zahl(tool.aufrufe)}</td>
                  <td className="px-2 py-2 tabular-nums">{tool.fehler > 0 ? tool.fehler : '—'}</td>
                  <td className="px-2 py-2 tabular-nums">{zahl(tool.token)}</td>
                  <td className="px-2 py-2 tabular-nums">{tool.p95} ms</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {daten.schluessel.ungenutzt.length > 0 && (
        <Card title="Seit über 60 Tagen ungenutzte Keys">
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            Diese Keys sind weiterhin gültig, werden aber nicht mehr benutzt. Ungenutzte Zugänge
            fallen im Alltag niemandem auf und sollten deaktiviert werden.
          </p>
          <Table kopf={['Name', 'Zuletzt benutzt']}>
            {daten.schluessel.ungenutzt.map((key) => (
              <tr key={key.id}>
                <td className="px-2 py-2">{key.name}</td>
                <td className="px-2 py-2 text-slate-500 dark:text-slate-400">{zeit(key.zuletzt)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {daten.letzteFehler.length > 0 && (
        <Card title="Letzte Fehler">
          <Table kopf={['Zeitpunkt', 'Tool', 'Zugang', 'Code']}>
            {daten.letzteFehler.map((ereignis) => (
              <tr key={ereignis.id}>
                <td className="px-2 py-2 text-slate-500 dark:text-slate-400">{zeit(ereignis.ts)}</td>
                <td className="px-2 py-2 font-mono text-xs">{ereignis.toolName}</td>
                <td className="px-2 py-2">{ereignis.apiKeyName ?? '—'}</td>
                <td className="px-2 py-2">
                  <Badge tone="bad">{ereignis.errorCode ?? 'FEHLER'}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}

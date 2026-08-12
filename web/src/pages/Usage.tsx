import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type UsageReport } from '../api';
import { Card, Notice, Spinner, Stat, Table, inputClass, zahl } from '../components/ui';

const ZEITRAEUME = [
  { label: '24 Stunden', tage: 1 },
  { label: '7 Tage', tage: 7 },
  { label: '30 Tage', tage: 30 },
  { label: '90 Tage', tage: 90 },
];

export default function UsagePage() {
  const [bericht, setBericht] = useState<UsageReport>();
  const [fehler, setFehler] = useState<string>();
  const [tage, setTage] = useState(7);

  useEffect(() => {
    setBericht(undefined);
    api
      .usage({ from: new Date(Date.now() - tage * 864e5).toISOString() })
      .then(setBericht)
      .catch((error) => setFehler(error.message));
  }, [tage]);

  if (fehler) return <Notice tone="bad">{fehler}</Notice>;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Nutzung</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Aufrufe, Latenzen und geschätzter Token-Verbrauch
          </p>
        </div>
        <select className={`${inputClass} w-40`} value={tage} onChange={(e) => setTage(Number(e.target.value))}>
          {ZEITRAEUME.map((zeitraum) => (
            <option key={zeitraum.tage} value={zeitraum.tage}>
              {zeitraum.label}
            </option>
          ))}
        </select>
      </header>

      {!bericht ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Tool-Aufrufe" value={zahl(bericht.zusammenfassung.aufrufe)} />
            <Stat
              label="Jama-Aufrufe"
              value={zahl(bericht.zusammenfassung.jamaAufrufe)}
              hint={`${bericht.zusammenfassung.wiederholungen} Wiederholungen nach Drosselung`}
            />
            <Stat
              label="Geschätzte Token"
              value={zahl(bericht.zusammenfassung.geschaetzteToken)}
              hint="Antwortgröße an den MCP-Client"
            />
            <Stat
              label="Cache-Trefferquote"
              value={`${bericht.zusammenfassung.cacheTrefferquote} %`}
              tone={bericht.zusammenfassung.cacheTrefferquote > 40 ? 'good' : 'neutral'}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Latenz p50" value={`${zahl(bericht.zusammenfassung.latenzP50)} ms`} />
            <Stat label="Latenz p95" value={`${zahl(bericht.zusammenfassung.latenzP95)} ms`} />
            <Stat label="Latenz p99" value={`${zahl(bericht.zusammenfassung.latenzP99)} ms`} />
            <Stat
              label="Fehlerquote"
              value={`${bericht.zusammenfassung.fehlerquote} %`}
              tone={bericht.zusammenfassung.fehlerquote > 10 ? 'bad' : bericht.zusammenfassung.fehlerquote > 3 ? 'warn' : 'good'}
            />
          </div>

          <Card title="Verlauf">
            {bericht.zeitreihe.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                Keine Aufrufe im gewählten Zeitraum.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={bericht.zeitreihe.map((punkt) => ({
                  ...punkt,
                  label: new Date(punkt.zeitpunkt).toLocaleString('de-DE', {
                    day: '2-digit', month: '2-digit',
                    ...(tage <= 3 ? { hour: '2-digit' } : {}),
                  }),
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" width={40} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="aufrufe" name="Aufrufe" fill="#0f172a" />
                  <Bar dataKey="fehler" name="Fehler" fill="#dc2626" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Tools nach Aufrufen">
              {bericht.topTools.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">Keine Daten.</p>
              ) : (
                <Table kopf={['Tool', 'Aufrufe', 'Fehler', 'Token', 'p95']}>
                  {bericht.topTools.map((tool) => (
                    <tr key={tool.tool}>
                      <td className="px-2 py-2 font-mono text-xs">{tool.tool}</td>
                      <td className="px-2 py-2 tabular-nums">{zahl(tool.aufrufe)}</td>
                      <td className="px-2 py-2 tabular-nums">{tool.fehler || '—'}</td>
                      <td className="px-2 py-2 tabular-nums">{zahl(tool.token)}</td>
                      <td className="px-2 py-2 tabular-nums">{tool.p95} ms</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card title="Zugänge nach Aufrufen">
              {bericht.topZugaenge.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">Keine Daten.</p>
              ) : (
                <Table kopf={['Zugang', 'Aufrufe', 'Token']}>
                  {bericht.topZugaenge.map((zugang, index) => (
                    <tr key={index}>
                      <td className="px-2 py-2">{zugang.zugang ?? 'entfernt'}</td>
                      <td className="px-2 py-2 tabular-nums">{zahl(zugang.aufrufe)}</td>
                      <td className="px-2 py-2 tabular-nums">{zahl(zugang.token)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

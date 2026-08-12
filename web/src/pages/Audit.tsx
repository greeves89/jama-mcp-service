import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, type AuditRow } from '../api';
import { Badge, Button, Card, Notice, Spinner, Table, inputClass, zeit } from '../components/ui';

/**
 * Audit-Log. Rein additiv und exportierbar — in regulierten Umgebungen ist das
 * der Nachweis, dass jede maschinelle Änderung nachvollziehbar bleibt.
 */
export default function AuditPage() {
  const [eintraege, setEintraege] = useState<AuditRow[]>();
  const [fehler, setFehler] = useState<string>();
  const [suche, setSuche] = useState('');

  useEffect(() => {
    api.audit(300).then(setEintraege).catch((error) => setFehler(error.message));
  }, []);

  if (fehler) return <Notice tone="bad">{fehler}</Notice>;
  if (!eintraege) return <Spinner />;

  const gefiltert = suche
    ? eintraege.filter((eintrag) =>
        [eintrag.action, eintrag.targetKey, eintrag.actorName, eintrag.message]
          .filter(Boolean)
          .some((wert) => String(wert).toLowerCase().includes(suche.toLowerCase())),
      )
    : eintraege;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Audit-Log</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Jede verändernde Operation und jede Verwaltungsaktion
          </p>
        </div>
        <a href="/admin/api/audit.csv" download>
          <Button variant="secondary">
            <Download size={14} />
            Als CSV
          </Button>
        </a>
      </header>

      <input
        className={inputClass}
        placeholder="Filtern nach Aktion, Ziel, Akteur oder Meldung"
        value={suche}
        onChange={(e) => setSuche(e.target.value)}
      />

      <Card>
        {gefiltert.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            Keine Einträge.
          </p>
        ) : (
          <Table kopf={['Zeitpunkt', 'Akteur', 'Aktion', 'Ziel', 'Ergebnis', 'Details']}>
            {gefiltert.map((eintrag) => (
              <tr key={eintrag.id}>
                <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {zeit(eintrag.ts)}
                </td>
                <td className="px-2 py-2 text-xs">
                  {eintrag.actorName ?? eintrag.actorType}
                  {eintrag.ip && (
                    <div className="text-slate-400">{eintrag.ip}</div>
                  )}
                </td>
                <td className="px-2 py-2 font-mono text-xs">{eintrag.action}</td>
                <td className="px-2 py-2 text-xs">{eintrag.targetKey ?? '—'}</td>
                <td className="px-2 py-2">
                  <Badge tone={eintrag.result === 'ok' ? 'good' : eintrag.result === 'denied' ? 'warn' : 'bad'}>
                    {eintrag.result}
                  </Badge>
                </td>
                <td className="max-w-md px-2 py-2 text-xs text-slate-600 dark:text-slate-300">
                  {eintrag.message}
                  {eintrag.payload && (
                    <code className="block truncate text-slate-400">
                      {JSON.stringify(eintrag.payload)}
                    </code>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

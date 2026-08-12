import { useEffect, useState } from 'react';
import { Play, Power, PowerOff, ShieldAlert, Wrench } from 'lucide-react';
import { api, type ToolCatalog, type ToolTryResult } from '../api';
import { Badge, Button, Card, Field, Notice, Spinner, inputClass, zahl } from '../components/ui';

/**
 * Tool-Katalog mit Probelauf.
 *
 * Der Probelauf zeigt exakt die Antwort, die ein LLM bekäme, samt Token-Schätzung
 * und Zahl der ausgelösten Jama-Aufrufe. Ohne dieses Werkzeug lässt sich ein
 * Tool-Zuschnitt nur beurteilen, indem man einen echten MCP-Client aufsetzt.
 */
export default function ToolsPage() {
  const [katalog, setKatalog] = useState<ToolCatalog>();
  const [fehler, setFehler] = useState<string>();
  const [filter, setFilter] = useState('');
  const [toolsetFilter, setToolsetFilter] = useState('');
  const [probelauf, setProbelauf] = useState<string>();
  const [schaltet, setSchaltet] = useState<string>();

  const laden = () => {
    api.tools().then(setKatalog).catch((error) => setFehler(error.message));
  };

  useEffect(laden, []);

  const umschalten = async (name: string, aktiv: boolean) => {
    setSchaltet(name);
    setFehler(undefined);
    try {
      await api.setToolActive(name, aktiv);
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Umschalten fehlgeschlagen');
    } finally {
      setSchaltet(undefined);
    }
  };

  if (fehler && !katalog) return <Notice tone="bad">{fehler}</Notice>;
  if (!katalog) return <Spinner />;

  const gefiltert = katalog.tools.filter((tool) => {
    if (toolsetFilter && tool.toolset !== toolsetFilter) return false;
    if (!filter) return true;
    const needle = filter.toLowerCase();
    return (
      tool.name.toLowerCase().includes(needle) ||
      tool.title.toLowerCase().includes(needle) ||
      tool.description.toLowerCase().includes(needle)
    );
  });

  const abgeschaltet = katalog.abgeschaltet.length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Tools</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {katalog.tools.length} Tools in {katalog.toolsets.length} Toolsets, dazu{' '}
          {katalog.prompts.length} vorgefertigte Abläufe
          {abgeschaltet > 0 && ` · ${abgeschaltet} abgeschaltet`}
        </p>
      </header>

      {fehler && <Notice tone="bad">{fehler}</Notice>}

      {abgeschaltet > 0 && (
        <Notice tone="warn">
          <span className="inline-flex items-center gap-1">
            <PowerOff size={14} />
            {abgeschaltet} {abgeschaltet === 1 ? 'Tool ist' : 'Tools sind'} instanzweit
            abgeschaltet: <code>{katalog.abgeschaltet.join(', ')}</code>. Abgeschaltete Tools
            werden keinem MCP-Client mehr angeboten — unabhängig davon, welche Toolsets ein
            Zugang hat.
          </span>
        </Notice>
      )}

      <div className="flex flex-wrap gap-3">
        <input
          className={`${inputClass} max-w-md`}
          placeholder="Tools durchsuchen"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className={`${inputClass} w-56`}
          value={toolsetFilter}
          onChange={(e) => setToolsetFilter(e.target.value)}
        >
          <option value="">Alle Toolsets</option>
          {katalog.toolsets.map((toolset) => (
            <option key={toolset.id} value={toolset.id}>
              {toolset.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {gefiltert.map((tool) => (
          <Card key={tool.name} className={tool.aktiv ? undefined : 'opacity-60'}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-sm font-semibold">{tool.name}</code>
                  <Badge>{tool.toolset}</Badge>
                  {!tool.aktiv && <Badge tone="bad">abgeschaltet</Badge>}
                  {tool.mutating && <Badge tone="warn">schreibend</Badge>}
                  {tool.destructive && (
                    <Badge tone="bad">
                      <ShieldAlert size={11} className="mr-0.5" />
                      Bestätigung nötig
                    </Badge>
                  )}
                  {tool.labs && <Badge tone="info">labs</Badge>}
                </div>
                <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-300">
                  {tool.description}
                </p>
                {tool.parameters.length > 0 && (
                  <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                    Parameter: {tool.parameters.join(', ')}
                  </p>
                )}
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                  30 Tage: {zahl(tool.nutzung30Tage.aufrufe)} Aufrufe
                  {tool.nutzung30Tage.fehler > 0 && `, ${tool.nutzung30Tage.fehler} Fehler`}
                  {tool.nutzung30Tage.token > 0 && `, ${zahl(tool.nutzung30Tage.token)} Token`}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-1.5">
                <Button
                  variant={tool.aktiv ? 'secondary' : 'primary'}
                  disabled={schaltet === tool.name}
                  onClick={() => void umschalten(tool.name, !tool.aktiv)}
                  title={
                    tool.aktiv
                      ? 'Instanzweit abschalten — das Tool verschwindet aus allen MCP-Clients'
                      : 'Wieder freigeben'
                  }
                >
                  {tool.aktiv ? <PowerOff size={13} /> : <Power size={13} />}
                  {schaltet === tool.name ? '…' : tool.aktiv ? 'Abschalten' : 'Freigeben'}
                </Button>
                <Button
                  variant="secondary"
                  disabled={!tool.aktiv}
                  onClick={() => setProbelauf(probelauf === tool.name ? undefined : tool.name)}
                >
                  <Play size={13} />
                  Probelauf
                </Button>
              </div>
            </div>

            {probelauf === tool.name && tool.aktiv && (
              <Probelauf toolName={tool.name} parameter={tool.parameters} />
            )}
          </Card>
        ))}
      </div>

      <Card title="Vorgefertigte Abläufe">
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          Diese Abläufe erscheinen im MCP-Client als auswählbare Aufgaben, sofern die benötigten
          Toolsets für den Zugang freigeschaltet sind.
        </p>
        <ul className="space-y-2">
          {katalog.prompts.map((prompt) => (
            <li key={prompt.name} className="flex items-center gap-2 text-sm">
              <Wrench size={14} className="text-slate-400" />
              <code className="text-xs">{prompt.name}</code>
              <span className="text-slate-600 dark:text-slate-300">{prompt.title}</span>
              <span className="flex gap-1">
                {prompt.requires.map((toolset) => (
                  <Badge key={toolset}>{toolset}</Badge>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Probelauf({ toolName, parameter }: { toolName: string; parameter: string[] }) {
  const [apiKey, setApiKey] = useState('');
  const [args, setArgs] = useState('{}');
  const [ergebnis, setErgebnis] = useState<ToolTryResult>();
  const [fehler, setFehler] = useState<string>();
  const [laeuft, setLaeuft] = useState(false);

  const ausfuehren = async () => {
    setLaeuft(true);
    setFehler(undefined);
    setErgebnis(undefined);
    try {
      const geparst = JSON.parse(args);
      setErgebnis(await api.tryTool(toolName, apiKey, geparst));
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Probelauf fehlgeschlagen');
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-700">
      <Notice tone="info">
        Der Probelauf läuft mit den Rechten des angegebenen API-Keys — inklusive aller Guards.
        Schreibende Tools verändern dabei echte Daten in Jama.
      </Notice>

      <Field label="API-Key" hint="Der vollständige Key des Zugangs, mit dem getestet werden soll.">
        <input
          type="password"
          className={inputClass}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="jama_mcp_..."
        />
      </Field>

      <Field
        label="Argumente als JSON"
        hint={parameter.length > 0 ? `Mögliche Parameter: ${parameter.join(', ')}` : 'Dieses Tool braucht keine Argumente.'}
      >
        <textarea
          className={`${inputClass} font-mono`}
          rows={3}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
      </Field>

      <Button onClick={() => void ausfuehren()} disabled={laeuft || apiKey.length === 0}>
        <Play size={14} />
        {laeuft ? 'Läuft' : 'Ausführen'}
      </Button>

      {fehler && <Notice tone="bad">{fehler}</Notice>}

      {ergebnis && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300">
            <span>{ergebnis.dauerMs} ms</span>
            <span>{ergebnis.jamaAufrufe} Jama-Aufrufe</span>
            <span>{ergebnis.cacheTreffer} Cache-Treffer</span>
            <span className="font-medium">~{zahl(ergebnis.geschaetzteToken)} Token</span>
          </div>
          <pre className="max-h-96 overflow-auto rounded border border-slate-300 bg-slate-50 p-3 text-xs dark:border-slate-600 dark:bg-slate-800">
            {ergebnis.antwort}
          </pre>
        </div>
      )}
    </div>
  );
}

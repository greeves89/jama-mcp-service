import { useEffect, useState } from 'react';
import { Ban, Check, Copy, KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { api, type ApiKeyRow, type Connection, type NeuerKey } from '../api';
import { Badge, Button, Card, Field, Notice, Spinner, Table, inputClass, zeit } from '../components/ui';

const TOOLSETS = [
  { id: 'core', label: 'Kern', mutating: false },
  { id: 'trace', label: 'Traceability', mutating: false },
  { id: 'write', label: 'Schreiben', mutating: true },
  { id: 'collab', label: 'Zusammenarbeit', mutating: true },
  { id: 'test', label: 'Test-Management', mutating: true },
  { id: 'history', label: 'Historie', mutating: true },
  { id: 'review', label: 'Reviews (labs)', mutating: false },
  { id: 'files', label: 'Dateien (labs)', mutating: true },
];

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[]>();
  const [verbindungen, setVerbindungen] = useState<Connection[]>([]);
  const [fehler, setFehler] = useState<string>();
  const [formularOffen, setFormularOffen] = useState(false);
  const [neuerKey, setNeuerKey] = useState<NeuerKey>();

  const laden = () => {
    api.keys().then(setKeys).catch((error) => setFehler(error.message));
    api.connections().then(setVerbindungen).catch(() => undefined);
  };

  useEffect(laden, []);

  const umschalten = async (key: ApiKeyRow) => {
    await api.updateKey(key.id, { disabled: key.disabledAt === null }).catch((error) => setFehler(error.message));
    laden();
  };

  const rotieren = async (key: ApiKeyRow) => {
    if (!confirm(`Key "${key.name}" rotieren? Der bisherige Wert wird sofort ungültig.`)) return;
    try {
      setNeuerKey(await api.rotateKey(key.id));
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Rotation fehlgeschlagen');
    }
  };

  const loeschen = async (key: ApiKeyRow) => {
    if (!confirm(`Key "${key.name}" endgültig löschen?`)) return;
    await api.deleteKey(key.id).catch((error) => setFehler(error.message));
    laden();
  };

  if (fehler && !keys) return <Notice tone="bad">{fehler}</Notice>;
  if (!keys) return <Spinner />;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">API-Keys</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Zugänge für MCP-Clients. Jeder Key trägt eigene Jama-Zugangsdaten und eigene
            Berechtigungen.
          </p>
        </div>
        <Button onClick={() => setFormularOffen(!formularOffen)} disabled={verbindungen.length === 0}>
          <Plus size={14} />
          Neuer Key
        </Button>
      </header>

      {fehler && <Notice tone="bad">{fehler}</Notice>}

      {verbindungen.length === 0 && (
        <Notice tone="warn">
          Es ist noch keine Jama-Verbindung angelegt. Ein API-Key braucht immer eine Verbindung —
          lege zuerst unter „Verbindungen" eine an.
        </Notice>
      )}

      {neuerKey && <KeyAnzeige daten={neuerKey} onSchliessen={() => setNeuerKey(undefined)} />}

      {formularOffen && (
        <NeuesKeyFormular
          verbindungen={verbindungen}
          onAbbrechen={() => setFormularOffen(false)}
          onAngelegt={(daten) => {
            setNeuerKey(daten);
            setFormularOffen(false);
            laden();
          }}
        />
      )}

      <Card>
        {keys.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            Noch keine Keys angelegt.
          </p>
        ) : (
          <Table
            kopf={['Name', 'Art', 'Toolsets', 'Rechte', 'Aufrufe 30 T.', 'Zuletzt', 'Status', '']}
          >
            {keys.map((key) => {
              const abgelaufen = key.expiresAt !== null && new Date(key.expiresAt) < new Date();
              return (
                <tr key={key.id}>
                  <td className="px-2 py-2">
                    <div className="font-medium">{key.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {key.owner} · <code>{key.keyPrefix}</code>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={key.accountType === 'service' ? 'info' : 'neutral'}>
                      {key.accountType === 'service' ? 'Service' : 'Person'}
                    </Badge>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-1">
                      {key.toolsets.map((toolset) => (
                        <Badge key={toolset}>{toolset}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={key.readOnly ? 'neutral' : 'warn'}>
                      {key.readOnly ? 'nur lesend' : 'schreibend'}
                    </Badge>
                    {key.allowedProjectIds.length > 0 && (
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        Projekte: {key.allowedProjectIds.join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {key.nutzung30Tage.aufrufe}
                    {key.nutzung30Tage.fehler > 0 && (
                      <span className="ml-1 text-xs text-red-600">({key.nutzung30Tage.fehler} F.)</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs text-slate-500 dark:text-slate-400">
                    {zeit(key.lastUsedAt)}
                  </td>
                  <td className="px-2 py-2">
                    {key.disabledAt ? (
                      <Badge tone="bad">deaktiviert</Badge>
                    ) : abgelaufen ? (
                      <Badge tone="bad">abgelaufen</Badge>
                    ) : (
                      <Badge tone="good">aktiv</Badge>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="secondary"
                        onClick={() => void umschalten(key)}
                        title={key.disabledAt ? 'Aktivieren' : 'Deaktivieren'}
                      >
                        {key.disabledAt ? <Check size={13} /> : <Ban size={13} />}
                      </Button>
                      <Button variant="secondary" onClick={() => void rotieren(key)} title="Rotieren">
                        <RotateCw size={13} />
                      </Button>
                      <Button variant="danger" onClick={() => void loeschen(key)} title="Löschen">
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}

function KeyAnzeige({ daten, onSchliessen }: { daten: NeuerKey; onSchliessen: () => void }) {
  const [kopiert, setKopiert] = useState(false);

  const kopieren = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setKopiert(true);
    setTimeout(() => setKopiert(false), 2000);
  };

  return (
    <Card title="Neuer API-Key" action={<Button variant="secondary" onClick={onSchliessen}>Schließen</Button>}>
      <Notice tone="warn">{daten.hinweis}</Notice>

      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-800">
          {daten.apiKey}
        </code>
        <Button onClick={() => void kopieren(daten.apiKey)}>
          <Copy size={14} />
          {kopiert ? 'Kopiert' : 'Kopieren'}
        </Button>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Konfiguration für den MCP-Client
          </span>
          <Button
            variant="secondary"
            onClick={() => void kopieren(JSON.stringify(daten.mcpKonfiguration, null, 2))}
          >
            <Copy size={13} />
            Kopieren
          </Button>
        </div>
        <pre className="overflow-x-auto rounded border border-slate-300 bg-slate-50 p-3 text-xs dark:border-slate-600 dark:bg-slate-800">
          {JSON.stringify(daten.mcpKonfiguration, null, 2)}
        </pre>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          In <code>.mcp.json</code> beziehungsweise <code>claude_desktop_config.json</code> eintragen.
        </p>
      </div>
    </Card>
  );
}

function NeuesKeyFormular({
  verbindungen,
  onAngelegt,
  onAbbrechen,
}: {
  verbindungen: Connection[];
  onAngelegt: (daten: NeuerKey) => void;
  onAbbrechen: () => void;
}) {
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [accountType, setAccountType] = useState<'user' | 'service'>('user');
  const [connectionId, setConnectionId] = useState(verbindungen[0]?.id ?? '');
  const [toolsets, setToolsets] = useState<string[]>(['core', 'trace']);
  const [readOnly, setReadOnly] = useState(true);
  const [projekte, setProjekte] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [authArt, setAuthArt] = useState<'connection' | 'oauth' | 'basic'>('connection');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fehler, setFehler] = useState<string>();
  const [laeuft, setLaeuft] = useState(false);

  const verbindung = verbindungen.find((v) => v.id === connectionId);
  const schreibendeToolsets = toolsets.filter((id) => TOOLSETS.find((t) => t.id === id)?.mutating);
  const warnungProduktiv = verbindung?.isProduction && !readOnly;

  const absenden = async (event: React.FormEvent) => {
    event.preventDefault();
    setLaeuft(true);
    setFehler(undefined);

    const projektIds = projekte
      .split(',')
      .map((eintrag) => Number.parseInt(eintrag.trim(), 10))
      .filter((eintrag) => Number.isFinite(eintrag));

    const credentials =
      authArt === 'oauth'
        ? { type: 'oauth' as const, clientId, clientSecret }
        : authArt === 'basic'
          ? { type: 'basic' as const, username, password }
          : undefined;

    try {
      onAngelegt(
        await api.createKey({
          name,
          owner,
          accountType,
          connectionId,
          toolsets,
          readOnly,
          allowedProjectIds: projektIds,
          expiresAt: expiresAt || undefined,
          credentials,
        }),
      );
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Anlegen fehlgeschlagen');
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <Card title="Neuen API-Key anlegen">
      <form onSubmit={absenden} className="space-y-4">
        {fehler && <Notice tone="bad">{fehler}</Notice>}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Verantwortlich" hint="Person, die für diesen Zugang einsteht.">
            <input className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)} required />
          </Field>

          <Field label="Art des Zugangs">
            <select
              className={inputClass}
              value={accountType}
              onChange={(e) => setAccountType(e.target.value as 'user' | 'service')}
            >
              <option value="user">Person</option>
              <option value="service">Service-Account (Automatisierung)</option>
            </select>
          </Field>

          <Field label="Jama-Verbindung">
            <select className={inputClass} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              {verbindungen.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.isProduction ? ' (produktiv)' : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Projekt-Allowlist"
            hint={
              accountType === 'service'
                ? 'Für Service-Accounts verpflichtend. Kommagetrennte Projekt-IDs.'
                : 'Kommagetrennte Projekt-IDs. Leer bedeutet: alle Projekte, die der Jama-Benutzer ohnehin sieht.'
            }
          >
            <input className={inputClass} value={projekte} onChange={(e) => setProjekte(e.target.value)} placeholder="12, 34" />
          </Field>

          <Field
            label="Gültig bis"
            hint={accountType === 'service' ? 'Für Service-Accounts verpflichtend.' : 'Optional.'}
          >
            <input type="date" className={inputClass} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        </div>

        <Field label="Toolsets">
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
            {TOOLSETS.map((toolset) => (
              <label key={toolset.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={toolsets.includes(toolset.id)}
                  onChange={(e) =>
                    setToolsets(
                      e.target.checked
                        ? [...toolsets, toolset.id]
                        : toolsets.filter((id) => id !== toolset.id),
                    )
                  }
                />
                {toolset.label}
                {toolset.mutating && <span className="text-xs text-amber-600">schreibend</span>}
              </label>
            ))}
          </div>
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          Nur lesender Zugriff
        </label>

        {!readOnly && schreibendeToolsets.length > 0 && (
          <Notice tone={warnungProduktiv ? 'bad' : 'warn'}>
            {warnungProduktiv
              ? `Dieser Key darf über die Toolsets ${schreibendeToolsets.join(', ')} in einer PRODUKTIVEN Jama-Instanz schreiben. Änderungen wirken sofort auf echte Projektdaten.`
              : `Dieser Key darf über die Toolsets ${schreibendeToolsets.join(', ')} Daten in Jama verändern.`}
          </Notice>
        )}

        <Field
          label="Jama-Zugangsdaten"
          hint="Eigene Zugangsdaten je Person sind der empfohlene Weg: die Jama-Berechtigungen greifen dann pro Benutzer und der Jama-Audit-Trail nennt den echten Verursacher."
        >
          <select className={inputClass} value={authArt} onChange={(e) => setAuthArt(e.target.value as typeof authArt)}>
            <option value="connection">Zugangsdaten der Verbindung verwenden</option>
            <option value="oauth">Eigene OAuth-Zugangsdaten (empfohlen)</option>
            <option value="basic">Eigene Basic-Auth-Zugangsdaten</option>
          </select>
        </Field>

        {authArt === 'oauth' && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Client-ID">
              <input className={inputClass} value={clientId} onChange={(e) => setClientId(e.target.value)} required />
            </Field>
            <Field label="Client-Secret">
              <input type="password" className={inputClass} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required />
            </Field>
          </div>
        )}

        {authArt === 'basic' && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Benutzername">
              <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} required />
            </Field>
            <Field label="Passwort">
              <input type="password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </div>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={laeuft || toolsets.length === 0}>
            <KeyRound size={14} />
            {laeuft ? 'Wird angelegt' : 'Key anlegen'}
          </Button>
          <Button variant="secondary" onClick={onAbbrechen}>
            Abbrechen
          </Button>
        </div>
      </form>
    </Card>
  );
}

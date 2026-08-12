import { useEffect, useState } from 'react';
import { Cable, Plus, TestTube2, Trash2 } from 'lucide-react';
import { api, type Connection, type ConnectionHealth } from '../api';
import { Badge, Button, Card, Field, Notice, Spinner, Table, inputClass, zeit } from '../components/ui';

export default function ConnectionsPage() {
  const [verbindungen, setVerbindungen] = useState<Connection[]>();
  const [fehler, setFehler] = useState<string>();
  const [formularOffen, setFormularOffen] = useState(false);
  const [testErgebnis, setTestErgebnis] = useState<Record<string, ConnectionHealth>>({});
  const [testLaeuft, setTestLaeuft] = useState<string>();

  const laden = () => {
    api.connections().then(setVerbindungen).catch((error) => setFehler(error.message));
  };

  useEffect(laden, []);

  const testen = async (id: string) => {
    setTestLaeuft(id);
    try {
      const ergebnis = await api.testConnection(id);
      setTestErgebnis((vorher) => ({ ...vorher, [id]: ergebnis }));
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Test fehlgeschlagen');
    } finally {
      setTestLaeuft(undefined);
    }
  };

  const loeschen = async (verbindung: Connection) => {
    if (!confirm(`Verbindung "${verbindung.name}" löschen?`)) return;
    try {
      await api.deleteConnection(verbindung.id);
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
    }
  };

  if (fehler && !verbindungen) return <Notice tone="bad">{fehler}</Notice>;
  if (!verbindungen) return <Spinner />;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Jama-Verbindungen</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Instanzen, gegen die dieser Dienst arbeitet. Zugangsdaten liegen verschlüsselt in der
            Datenbank und verlassen den Server nie.
          </p>
        </div>
        <Button onClick={() => setFormularOffen(!formularOffen)}>
          <Plus size={14} />
          Neue Verbindung
        </Button>
      </header>

      {fehler && <Notice tone="bad">{fehler}</Notice>}

      {formularOffen && (
        <NeueVerbindung
          onAbbrechen={() => setFormularOffen(false)}
          onAngelegt={() => {
            setFormularOffen(false);
            laden();
          }}
        />
      )}

      <Card>
        {verbindungen.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            Noch keine Verbindung angelegt.
          </p>
        ) : (
          <Table kopf={['Name', 'Instanz', 'Auth', 'Limit', 'Zustand', 'Geprüft', '']}>
            {verbindungen.map((verbindung) => (
              <tr key={verbindung.id}>
                <td className="px-2 py-2">
                  <div className="font-medium">{verbindung.name}</div>
                  {verbindung.isProduction && (
                    <Badge tone="bad">Produktivsystem</Badge>
                  )}
                </td>
                <td className="px-2 py-2">
                  <code className="text-xs">{verbindung.baseUrl}</code>
                  {verbindung.apiVersion && (
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      API: {verbindung.apiVersion}
                    </div>
                  )}
                </td>
                <td className="px-2 py-2">
                  <Badge tone={verbindung.authType === 'oauth' ? 'good' : 'neutral'}>
                    {verbindung.authType === 'oauth' ? 'OAuth' : 'Basic'}
                  </Badge>
                </td>
                <td className="px-2 py-2 tabular-nums text-xs">
                  {verbindung.rateLimitRps ?? 'Standard'}
                  {verbindung.rateLimitRps ? '/s' : ''}
                </td>
                <td className="px-2 py-2">
                  <Badge
                    tone={
                      verbindung.healthStatus === 'ok'
                        ? 'good'
                        : verbindung.healthStatus === 'error'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {verbindung.healthStatus}
                  </Badge>
                  {testErgebnis[verbindung.id] && (
                    <div className="mt-1 max-w-xs text-xs text-slate-600 dark:text-slate-300">
                      {testErgebnis[verbindung.id]!.message}
                    </div>
                  )}
                  {!testErgebnis[verbindung.id] && verbindung.healthMessage && (
                    <div className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
                      {verbindung.healthMessage}
                    </div>
                  )}
                </td>
                <td className="px-2 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {zeit(verbindung.lastHealthCheckAt)}
                </td>
                <td className="px-2 py-2">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="secondary"
                      onClick={() => void testen(verbindung.id)}
                      disabled={testLaeuft === verbindung.id}
                      title="Verbindung testen"
                    >
                      <TestTube2 size={13} />
                      {testLaeuft === verbindung.id ? 'Test läuft' : 'Testen'}
                    </Button>
                    <Button variant="danger" onClick={() => void loeschen(verbindung)} title="Löschen">
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function NeueVerbindung({
  onAngelegt,
  onAbbrechen,
}: {
  onAngelegt: () => void;
  onAbbrechen: () => void;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [isProduction, setIsProduction] = useState(false);
  const [rateLimitRps, setRateLimitRps] = useState('6');
  const [authArt, setAuthArt] = useState<'oauth' | 'basic'>('oauth');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fehler, setFehler] = useState<string>();
  const [laeuft, setLaeuft] = useState(false);

  const absenden = async (event: React.FormEvent) => {
    event.preventDefault();
    setLaeuft(true);
    setFehler(undefined);
    try {
      await api.createConnection({
        name,
        baseUrl,
        isProduction,
        rateLimitRps: Number.parseFloat(rateLimitRps),
        credentials:
          authArt === 'oauth'
            ? { type: 'oauth', clientId, clientSecret }
            : { type: 'basic', username, password },
      });
      onAngelegt();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Anlegen fehlgeschlagen');
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <Card title="Neue Jama-Verbindung">
      <form onSubmit={absenden} className="space-y-4">
        {fehler && <Notice tone="bad">{fehler}</Notice>}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" hint="Frei wählbar, zum Beispiel Sandbox oder Produktion.">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Basis-URL" hint="Ohne /rest — etwa https://beispiel.jamacloud.com">
            <input
              className={inputClass}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://beispiel.jamacloud.com"
              required
            />
          </Field>
          <Field
            label="Anfragen pro Sekunde"
            hint="Jama drosselt bei 10/s für die gesamte Instanz. Ein Wert unter dem Limit lässt Luft für andere Integrationen."
          >
            <input
              type="number"
              step="0.5"
              min="0.5"
              max="10"
              className={inputClass}
              value={rateLimitRps}
              onChange={(e) => setRateLimitRps(e.target.value)}
            />
          </Field>
          <Field label="Authentifizierung" hint="OAuth funktioniert auch in SSO-Umgebungen, Basic Auth nicht.">
            <select className={inputClass} value={authArt} onChange={(e) => setAuthArt(e.target.value as typeof authArt)}>
              <option value="oauth">OAuth 2.0 (empfohlen)</option>
              <option value="basic">Basic Auth</option>
            </select>
          </Field>
        </div>

        {authArt === 'oauth' ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Client-ID">
              <input className={inputClass} value={clientId} onChange={(e) => setClientId(e.target.value)} required />
            </Field>
            <Field label="Client-Secret" hint="Jama zeigt das Secret nur einmal an.">
              <input type="password" className={inputClass} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Benutzername">
              <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} required />
            </Field>
            <Field label="Passwort">
              <input type="password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isProduction} onChange={(e) => setIsProduction(e.target.checked)} />
          Dies ist ein Produktivsystem
        </label>

        {isProduction && (
          <Notice tone="warn">
            Produktivverbindungen werden überall rot markiert. Schreibende Keys auf dieser
            Verbindung wirken auf echte Projektdaten.
          </Notice>
        )}

        <Notice tone="info">
          Der REST-Zugriff erfordert eine Named-Creator-Lizenz. Mit einer Creator-Float-Lizenz
          schlägt jeder Aufruf fehl — der Verbindungstest zeigt den Lizenztyp an.
        </Notice>

        <div className="flex gap-2">
          <Button type="submit" disabled={laeuft}>
            <Cable size={14} />
            {laeuft ? 'Wird angelegt' : 'Verbindung anlegen'}
          </Button>
          <Button variant="secondary" onClick={onAbbrechen}>
            Abbrechen
          </Button>
        </div>
      </form>
    </Card>
  );
}

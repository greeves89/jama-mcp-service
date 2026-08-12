import { useEffect, useState } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { Button, Notice, inputClass } from '../components/ui';

/**
 * Anmeldung per PIN. Die Sperre wird ausdruecklich angezeigt, damit ein
 * Anwender nach mehreren Fehlversuchen weiss, warum nichts mehr geht — und ein
 * Angreifer sieht ohnehin nur, dass gesperrt ist.
 */
export default function LoginPage({ onAngemeldet }: { onAngemeldet: () => void }) {
  const [pin, setPin] = useState('');
  const [fehler, setFehler] = useState<string>();
  const [laeuft, setLaeuft] = useState(false);
  const [eingerichtet, setEingerichtet] = useState(true);
  const [gesperrt, setGesperrt] = useState(false);

  useEffect(() => {
    api
      .status()
      .then((status) => {
        setEingerichtet(status.pinEingerichtet);
        setGesperrt(status.sperre.gesperrt);
      })
      .catch(() => undefined);
  }, []);

  const absenden = async (event: React.FormEvent) => {
    event.preventDefault();
    setLaeuft(true);
    setFehler(undefined);
    try {
      await api.login(pin);
      onAngemeldet();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Anmeldung fehlgeschlagen');
      const status = await api.status().catch(() => undefined);
      setGesperrt(status?.sperre.gesperrt ?? false);
    } finally {
      setLaeuft(false);
      setPin('');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
            <Lock size={20} />
          </div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Jama MCP</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Verwaltung</p>
        </div>

        <form
          onSubmit={absenden}
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900"
        >
          {!eingerichtet && (
            <Notice tone="warn">
              Es ist noch kein PIN eingerichtet. Setze <code>ADMIN_INITIAL_PIN</code> in der
              Umgebung und starte den Dienst neu, oder erzeuge die Konfiguration mit{' '}
              <code>npm run secrets</code>.
            </Notice>
          )}

          {gesperrt && (
            <Notice tone="bad">
              <span className="inline-flex items-center gap-1">
                <ShieldAlert size={14} />
                Zu viele Fehlversuche. Der Zugang von dieser Adresse ist vorübergehend gesperrt.
              </span>
            </Notice>
          )}

          {fehler && !gesperrt && <Notice tone="bad">{fehler}</Notice>}

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              PIN
            </span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              autoFocus
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              className={`${inputClass} tracking-[0.3em]`}
              placeholder="········"
            />
          </label>

          <Button type="submit" disabled={laeuft || pin.length < 8 || gesperrt}>
            {laeuft ? 'Wird geprüft' : 'Anmelden'}
          </Button>
        </form>
      </div>
    </div>
  );
}

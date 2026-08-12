import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  Activity,
  Cable,
  ChartNoAxesColumn,
  KeyRound,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Settings,
  Wrench,
} from 'lucide-react';
import { api } from './api';
import { Spinner } from './components/ui';
import LoginPage from './pages/Login';
import OverviewPage from './pages/Overview';
import KeysPage from './pages/Keys';
import ConnectionsPage from './pages/Connections';
import UsagePage from './pages/Usage';
import AuditPage from './pages/Audit';
import EventsPage from './pages/Events';
import ToolsPage from './pages/Tools';
import SettingsPage from './pages/SettingsPage';

const navigation = [
  { to: '/', label: 'Uebersicht', Icon: LayoutDashboard, end: true },
  { to: '/keys', label: 'API-Keys', Icon: KeyRound },
  { to: '/connections', label: 'Verbindungen', Icon: Cable },
  { to: '/usage', label: 'Nutzung', Icon: ChartNoAxesColumn },
  { to: '/audit', label: 'Audit-Log', Icon: ScrollText },
  { to: '/events', label: 'Aufrufe', Icon: Activity },
  { to: '/tools', label: 'Tools', Icon: Wrench },
  { to: '/settings', label: 'Einstellungen', Icon: Settings },
];

export default function App() {
  const [angemeldet, setAngemeldet] = useState<boolean | undefined>(undefined);
  const navigate = useNavigate();

  const pruefen = () => {
    api
      .status()
      .then((status) => setAngemeldet(status.angemeldet))
      .catch(() => setAngemeldet(false));
  };

  useEffect(pruefen, []);

  if (angemeldet === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Spinner />
      </div>
    );
  }

  if (!angemeldet) {
    return <LoginPage onAngemeldet={() => setAngemeldet(true)} />;
  }

  const abmelden = async () => {
    await api.logout().catch(() => undefined);
    setAngemeldet(false);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-0 h-screen w-56 shrink-0 border-r border-slate-200 bg-white px-3 py-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-6 px-2">
            <div className="text-sm font-semibold">Jama MCP</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Verwaltung</div>
          </div>

          <nav className="space-y-0.5">
            {navigation.map(({ to, label, Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
                    isActive
                      ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`
                }
              >
                <Icon size={16} />
                {label}
              </NavLink>
            ))}
          </nav>

          <button
            onClick={() => void abmelden()}
            className="mt-6 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <LogOut size={16} />
            Abmelden
          </button>
        </aside>

        <main className="min-w-0 flex-1 p-6">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/settings" element={<SettingsPage onAbgemeldet={() => setAngemeldet(false)} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

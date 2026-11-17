import { useEffect, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { loadState, useAppState } from './lib/store';
import { connect, setForeground } from './lib/linkClient';
import { ConnectionStatus, Icon, type IconName } from './components/ui';
import ChatScreen from './screens/Chat';
import TasksScreen from './screens/Tasks';
import MemoryScreen from './screens/Memory';
import ApprovalsScreen from './screens/Approvals';
import SettingsScreen from './screens/Settings';
import Onboarding from './screens/Onboarding';

type Tab = 'chat' | 'tasks' | 'memory' | 'approvals' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'approvals', label: 'Approve', icon: 'shield' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export default function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [skipOnboarding, setSkip] = useState(false);
  const { link, approvals, providerSet } = useAppState((s) => ({ link: s.link, approvals: s.approvals.length, providerSet: Boolean(s.provider.baseUrl) }));

  useEffect(() => {
    void loadState().then(() => {
      setReady(true);
      void connect();
    });
    // Battery: the live channel exists only while JINI is on screen.
    const sub = CapApp.addListener('appStateChange', ({ isActive }) => setForeground(isActive));
    const onVis = () => setForeground(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => {
      void sub.then((s) => s.remove());
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  if (!ready) return <div className="h-full bg-bg" />;
  if (!link && !providerSet && !skipOnboarding) return <Onboarding onDone={() => setSkip(true)} />;

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="safe-top flex items-center justify-between px-5 pb-1">
        <span className="text-[17px] font-semibold tracking-[-0.01em] text-text">
          jini<span className="text-accent">.</span>
        </span>
        <ConnectionStatus />
      </header>
      <Toast />
      <main className="min-h-0 flex-1 overflow-y-auto px-4">
        {tab === 'chat' && <ChatScreen />}
        {tab === 'tasks' && <TasksScreen />}
        {tab === 'memory' && <MemoryScreen />}
        {tab === 'approvals' && <ApprovalsScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </main>
      <nav className="safe-bottom flex border-t border-hairline bg-bg pt-1.5" aria-label="Sections">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-1 flex-col items-center gap-1 py-1.5 text-[11px] font-medium ${active ? 'text-accent' : 'text-faint'}`}
            >
              <Icon name={t.icon} className="h-[22px] w-[22px]" />
              {t.label}
              {t.id === 'approvals' && approvals > 0 && (
                <span className="absolute left-1/2 top-0.5 ml-2 min-w-[16px] rounded-full bg-warn px-1 text-center text-[10px] font-semibold leading-4 text-bg">{approvals}</span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function Toast() {
  const toast = useAppState((s) => s.toast);
  if (!toast) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 top-[calc(max(env(safe-area-inset-top),14px)+40px)] z-50 flex justify-center px-6">
      <div className="rounded-xl bg-text px-4 py-2.5 text-[14px] font-medium text-bg">{toast}</div>
    </div>
  );
}

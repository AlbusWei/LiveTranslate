import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { LivePage } from './pages/LivePage';
import { FileDubPage } from './pages/FileDubPage';
import { MeetingPage } from './pages/MeetingPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { createGatewayApi } from './api';

export function App(): JSX.Element {
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  useEffect(() => {
    void createGatewayApi().getSettings().then((r) => setHasKey(r.hasKey)).catch(() => setHasKey(false));
  }, []);

  if (hasKey === null) {
    return <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9C9A94' }}>加载中…</div>;
  }

  return (
    <HashRouter>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="*" element={
          hasKey ? (
            <AppShell>
              <Routes>
                <Route path="/live" element={<LivePage />} />
                <Route path="/dub" element={<FileDubPage />} />
                <Route path="/meeting" element={<MeetingPage />} />
                <Route path="/history" element={<HistoryPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/live" replace />} />
              </Routes>
            </AppShell>
          ) : (
            <Navigate to="/onboarding" replace />
          )
        } />
      </Routes>
    </HashRouter>
  );
}

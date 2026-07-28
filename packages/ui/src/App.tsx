import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { SoloPage } from './pages/SoloPage';
import { FileDubPage } from './pages/FileDubPage';
import { InterpreterPage } from './pages/InterpreterPage';
import { MeetingPage } from './pages/MeetingPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

const NAV = [
  { to: '/', label: '单人测试' },
  { to: '/filedub', label: '翻译机·配音' },
  { to: '/interpreter', label: '实时翻译机' },
  { to: '/meeting', label: '会议' },
  { to: '/history', label: '历史' },
  { to: '/settings', label: '设置' },
];

export function App(): JSX.Element {
  return (
    <HashRouter>
      <div className="app-shell">
        <nav className="side-nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="page-body">
          <Routes>
            <Route path="/" element={<SoloPage />} />
            <Route path="/filedub" element={<FileDubPage />} />
            <Route path="/interpreter" element={<InterpreterPage />} />
            <Route path="/meeting" element={<MeetingPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}

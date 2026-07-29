import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Mic, AudioLines, Users, History, Settings, ChevronsLeft, ChevronsRight, Globe } from 'lucide-react';

const MAIN_NAV = [
  { to: '/live', label: '实时翻译', icon: Mic },
  { to: '/dub', label: '文件配音', icon: AudioLines },
  { to: '/meeting', label: '会议', icon: Users },
];

const BOTTOM_NAV = [
  { to: '/history', label: '历史', icon: History },
  { to: '/settings', label: '设置', icon: Settings },
];

export function AppShell({ children }: { children: React.ReactNode }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const check = () => setCollapsed(window.innerWidth < 1100);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return (
    <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <nav className="sidebar">
        <NavLink to="/live" className="sidebar-brand">
          <div className="brand-mark">
            <Globe viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          </div>
          <span className="brand-name">LiveTranslate</span>
        </NavLink>

        <div className="nav-section-title">模式</div>
        {MAIN_NAV.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Icon />
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}

        <div className="nav-spacer" />

        {BOTTOM_NAV.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Icon />
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}

        <button className="sidebar-toggle" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开侧边栏' : '收缩侧边栏'}>
          {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
        </button>
      </nav>

      <main className="page-body">
        {children}
      </main>
    </div>
  );
}

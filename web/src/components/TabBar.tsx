import { NavLink, useLocation } from 'react-router-dom'
import { Icon, type IconName } from './ui'
import './TabBar.css'

const tabs: { to: string; label: string; icon: IconName }[] = [
  { to: '/heute', label: 'Heute', icon: 'sun' },
  { to: '/training', label: 'Training', icon: 'run' },
  { to: '/essen', label: 'Essen', icon: 'food' },
  { to: '/chat', label: 'Chat', icon: 'chat' },
  { to: '/verlauf', label: 'Verlauf', icon: 'history' },
]

export default function TabBar() {
  const { pathname } = useLocation()
  return (
    <nav className="tabbar-coach" aria-label="Hauptnavigation">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) =>
            isActive || (t.to === '/heute' && pathname.startsWith('/tageslinie'))
              ? 'tabbar-coach-item active'
              : 'tabbar-coach-item'
          }
        >
          <Icon name={t.icon} size={24} />
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}

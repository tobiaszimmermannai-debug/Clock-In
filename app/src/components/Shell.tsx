// App-Rahmen: Seitenleiste am Desktop, Tab-Leiste unten am Handy
import type { ReactNode } from "react";
import { BrandMark, Icon, type IconName } from "./ui";

export type ShellTab<T extends string> = { id: T; label: string; icon: IconName; badge?: number };

export function Shell<T extends string>(props: {
  title: string;
  subtitle: string;
  tabs: ShellTab<T>[];
  current: T;
  onTab: (id: T) => void;
  onLogout?: () => void;
  children: ReactNode;
}) {
  const brand = (
    <span className="brand">
      <BrandMark />
      <span>
        {props.title}
        <span className="brand-sub">{props.subtitle}</span>
      </span>
    </span>
  );
  return (
    <div className="shell">
      {/* Viele Bereiche: am Handy kleinere Beschriftung, damit alle in die Leiste passen */}
      <nav className={props.tabs.length > 5 ? "tabbar is-crowded" : "tabbar"} aria-label="Bereiche">
        <div className="tabbar-brand">{brand}</div>
        {props.tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tab"
            aria-current={props.current === t.id ? "page" : undefined}
            onClick={() => props.onTab(t.id)}
          >
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
            {!!t.badge && <span className="tab-badge">{t.badge}</span>}
          </button>
        ))}
        {props.onLogout && (
          <div className="tabbar-foot">
            <button type="button" className="tab" onClick={props.onLogout}>
              <Icon name="logout" size={22} />
              <span>Abmelden</span>
            </button>
          </div>
        )}
      </nav>
      <div>
        <header className="topbar">
          {brand}
          <span className="spacer" />
          {props.onLogout && (
            <button type="button" className="icon-btn" aria-label="Abmelden" onClick={props.onLogout}>
              <Icon name="logout" size={20} />
            </button>
          )}
        </header>
        <main className="content">{props.children}</main>
      </div>
    </div>
  );
}

export interface TabItem {
  key: string;
  label: string;
  /** 右侧计数/状态徽标；为 undefined 或空串时不渲染 */
  count?: number | string;
}

interface Props {
  tabs: TabItem[];
  active: string;
  onChange: (key: string) => void;
}

/**
 * 页内 tab 条（石墨薄雾）：2px 下划线 active 样式，右侧可带计数徽标。
 * 统一日志「观察/规则」与 API Tester「请求头/请求体/响应/…」两处 tab 条。
 */
export default function TabStrip({ tabs, active, onChange }: Props) {
  return (
    <div className="subtabs shrink-0">
      {tabs.map((t) => (
        <button
          key={t.key}
          className={`subtab ${active === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
          aria-current={active === t.key ? 'page' : undefined}
        >
          {t.label}
          {t.count !== undefined && t.count !== '' && <span className="subtab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

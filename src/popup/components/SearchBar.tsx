import { useEffect, useRef } from 'react';
import Icon from './Icon';

/**
 * 统一搜索栏（石墨薄雾）
 * - 输入框 + 命中计数（当前/总数）+ 上一个/下一个/关闭。
 * - Enter 下一个、Shift+Enter 上一个、Esc 关闭；打开时自动聚焦。
 * - 纯展示层，命中/定位逻辑在 search.tsx。
 */
interface SearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  count: number;
  index: number; // 0-based 当前项；-1 表示未定位
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  placeholder?: string;
}

export default function SearchBar({ query, onQueryChange, count, index, onNext, onPrev, onClose, placeholder = '搜索关键字…' }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="search-bar">
      <Icon name="search" size={12} className="shrink-0" style={{ color: 'var(--faint)' }} aria-hidden />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        placeholder={placeholder}
        className="search-bar-input"
      />
      <span className="search-bar-count" style={{ color: count ? 'var(--text2)' : 'var(--faint)' }}>
        {count ? `${index >= 0 ? index + 1 : 0}/${count}` : '0/0'}
      </span>
      <button type="button" className="btn-ghost p-0.5" onClick={onPrev} disabled={!count} aria-label="上一个" data-tip="上一个">
        <Icon name="chevron-up" size={14} />
      </button>
      <button type="button" className="btn-ghost p-0.5" onClick={onNext} disabled={!count} aria-label="下一个" data-tip="下一个">
        <Icon name="chevron-down" size={14} />
      </button>
      <button type="button" className="btn-ghost p-0.5" onClick={onClose} aria-label="关闭搜索" data-tip="关闭搜索">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

import { useState, useRef, useEffect, useLayoutEffect, useCallback, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

/**
 * 自绘下拉（替代原生 <select>）：触发器沿用字段外观，弹层复用设置菜单风格（.settings-menu/.menu-item）。
 * - 原生 <option> 弹层在暗色下无法可靠跟随主题（系统绘制），故整体换成自绘菜单。
 * - 弹层用 portal + position:fixed 渲染到 body，避免被滚动容器/卡片 overflow 裁切；越界自动上翻并夹在视口内。
 * - 打开时同步计算位置（避免二次渲染空窗）；聚焦用 preventScroll，滚动/缩放时重定位而非关闭，
 *   仅点击外部与 Esc 关闭。
 * - 键盘：触发器 Enter/Space/↓ 展开；菜单 ↑↓ 移动、Enter 选中、Esc 关闭。
 */
export interface SelectOption {
  value: string;
  label: React.ReactNode;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** box=带边框字段外观（默认）；plain=透明内联（如动作标题下拉） */
  variant?: 'box' | 'plain';
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  placeholder?: string;
}

export default function Select({
  value, onChange, options, variant = 'box',
  className = '', style, disabled, invalid, ariaLabel, placeholder,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected = selectedIdx >= 0 ? options[selectedIdx] : undefined;

  // 依触发器 rect 计算弹层位置；越界则上翻并夹在视口内。
  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mh = menuRef.current?.offsetHeight ?? 0;
    const vh = window.innerHeight;
    let top = r.bottom + 4;
    if (mh && top + mh > vh - 8) top = Math.max(8, r.top - mh - 4);
    setPos({ left: r.left, top, minWidth: r.width });
  }, []);

  const openMenu = () => {
    if (disabled) return;
    setActive(selectedIdx >= 0 ? selectedIdx : 0);
    place();           // 同步定位，菜单首帧即有坐标
    setOpen(true);
  };

  // 菜单渲染后按真实高度再校正一次（上翻判断需要 offsetHeight），并聚焦（preventScroll 防触发滚动）。
  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, active, place]);

  useEffect(() => {
    if (open) menuRef.current?.focus({ preventScroll: true });
  }, [open]);

  // 打开期间：点击外部 / Esc 关闭；滚动 / 缩放重定位（不关闭）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }
    };
    const onReflow = (e: Event) => {
      if (e.type === 'scroll' && menuRef.current?.contains(e.target as Node)) return; // 菜单内部滚动不重定位
      place();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, place]);

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const onTriggerKey = (e: ReactKeyboardEvent) => {
    if (disabled) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openMenu();
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = options[active]; if (o) commit(o.value); }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        data-open={open || undefined}
        className={`select-trigger ${variant === 'plain' ? 'plain' : ''} ${invalid ? 'invalid' : ''} ${className}`}
        style={style}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        <span className="select-value">{selected?.label ?? placeholder ?? ''}</span>
        <Icon name="chevron-down" size={14} className="select-chev" />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          tabIndex={-1}
          className="select-menu"
          style={{ left: pos.left, top: pos.top, minWidth: pos.minWidth }}
          onKeyDown={onMenuKey}
        >
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`menu-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(o.value)}
            >
              <span className="select-opt-label">{o.label}</span>
              {o.value === value && <Icon name="check" size={14} className="select-opt-check" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

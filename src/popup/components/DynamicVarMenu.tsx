import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { DYNAMIC_VAR_TOKENS, resolveDynamicVars } from '../../shared/dynamic-vars';

/**
 * 动态变量插入菜单
 *
 * 触发器为一个小按钮（时钟图标）；展开后列出内置动态变量（{{$ts}} 等），
 * 每项带一行当前时刻的实时解析预览。点击某项即把占位符插入到目标输入框/文本域的光标处，
 * 并回写到父组件状态（父持有输入值的单一数据源），随后恢复焦点与光标位置。
 *
 * 弹层复用 Select 的 portal + fixed 定位思路，避免被滚动容器裁切。
 */
interface DynamicVarMenuProps {
  /** 目标输入框/文本域，用于读取光标位置与恢复焦点；不传则插入到值末尾 */
  targetRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** 当前值（父状态） */
  value: string;
  /** 插入后回写新值（父负责 setState） */
  onInsert: (next: string) => void;
  /** 触发器额外类名 */
  className?: string;
  /** 无障碍/提示文案 */
  label?: string;
}

export default function DynamicVarMenu({ targetRef, value, onInsert, className = '', label = '插入动态变量' }: DynamicVarMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [nowTick, setNowTick] = useState(0); // 打开时刷新预览
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<number | null>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mh = menuRef.current?.offsetHeight ?? 0;
    const mw = menuRef.current?.offsetWidth ?? 220;
    const vh = window.innerHeight;
    let top = r.bottom + 4;
    if (mh && top + mh > vh - 8) top = Math.max(8, r.top - mh - 4);
    let left = r.right - mw; // 右对齐触发器
    if (left < 8) left = 8;
    setPos({ left, top });
  }, []);

  const openMenu = () => {
    setNowTick((t) => t + 1);
    place();
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

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
    const onReflow = () => place();
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

  // 插入后恢复光标位置（等父状态回写到 DOM 后再设）
  useEffect(() => {
    if (caretRef.current == null) return;
    const el = targetRef?.current;
    if (el) {
      const p = caretRef.current;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(p, p); } catch (_) {}
    }
    caretRef.current = null;
  }, [value, targetRef]);

  const insert = (text: string) => {
    const el = targetRef?.current;
    let start = value.length;
    let end = value.length;
    if (el && el.selectionStart != null && el.selectionEnd != null) {
      start = el.selectionStart;
      end = el.selectionEnd;
    }
    const next = value.slice(0, start) + text + value.slice(end);
    caretRef.current = el ? start + text.length : null;
    onInsert(next);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-tip={label}
        className={`btn-ghost p-1 ${open ? 'text-primary-600' : ''} ${className}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <Icon name="clock-3" size={14} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="settings-menu"
          style={{ position: 'fixed', left: pos.left, top: pos.top, right: 'auto', minWidth: 220 }}
        >
          {DYNAMIC_VAR_TOKENS.map((t) => {
            // nowTick 仅用于打开时触发重渲染，使预览取当前时刻
            void nowTick;
            const preview = resolveDynamicVars(t.insert);
            return (
              <button
                key={t.name}
                type="button"
                role="menuitem"
                className="menu-item"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}
                onClick={() => insert(t.insert)}
              >
                <span className="flex items-center justify-between gap-2">
                  <code style={{ fontSize: 11.5, color: 'var(--accent-fg, #4f46e5)' }}>{t.insert}</code>
                  <span style={{ fontSize: 11, color: 'var(--text2)' }}>{t.label}</span>
                </span>
                <span style={{ fontSize: 10.5, color: 'var(--text3, var(--text2))', opacity: 0.8, wordBreak: 'break-all' }}>
                  = {preview}
                </span>
              </button>
            );
          })}
          <div style={{ padding: '6px 10px 2px', fontSize: 10, color: 'var(--text2)', opacity: 0.75, lineHeight: 1.4 }}>
            支持秒级偏移，如 <code>{'{{$ts+30}}'}</code>、<code>{'{{$ts-60}}'}</code>；发送时按当前时刻解析
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

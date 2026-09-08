import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { DYNAMIC_VAR_TOKENS, resolveDynamicVars } from '../../shared/dynamic-vars';

/** 插入目标：光标所在的输入框/文本域，以及把新值写回父状态的回调 */
export interface InsertTarget {
  el: HTMLInputElement | HTMLTextAreaElement | null;
  apply: (next: string) => void;
}

/**
 * 动态变量插入菜单
 *
 * 触发器为一个小按钮（时钟图标）；展开后列出内置动态变量（{{$ts}} 等），
 * 每项带一行当前时刻的实时解析预览。
 *
 * 目标输入框在「点击某项时」才通过 resolveTarget() 动态解析——这样单个按钮即可
 * 把占位符插入到「当前光标所在」的任意字段（URL / query 参数 / 请求头 / 请求体）。
 * 插入后按选区起点计算新光标位置，等父状态回写到受控 DOM 后恢复焦点与光标。
 *
 * 弹层复用 Select 的 portal + fixed 定位思路，避免被滚动容器裁切。
 */
interface DynamicVarMenuProps {
  /** 点击插入项时解析当前目标（光标所在字段）；返回 null 或无 el 时不插入 */
  resolveTarget: () => InsertTarget | null;
  /** 触发器额外类名 */
  className?: string;
  /** 无障碍/提示文案 */
  label?: string;
}

export default function DynamicVarMenu({ resolveTarget, className = '', label = '插入动态变量' }: DynamicVarMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [nowTick, setNowTick] = useState(0); // 打开时刷新预览
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const insert = (text: string) => {
    setOpen(false);
    const target = resolveTarget();
    const el = target?.el;
    if (!target || !el) return; // 无法定位光标时宁可不插入，也不误插到别处
    // 以 DOM 为准读取「当前值」与选区，避免父状态回写与实时输入之间的时序错位
    const cur = el.value;
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + text + cur.slice(end);
    const caret = start + text.length;
    target.apply(next);
    // 等受控组件把新值渲染到 DOM 后，再恢复焦点与光标位置
    requestAnimationFrame(() => {
      try { el.focus({ preventScroll: true }); el.setSelectionRange(caret, caret); } catch (_) { /* 元素可能已卸载 */ }
    });
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
            插入到光标所在字段（URL / 参数 / 请求头 / 请求体）；支持秒级偏移，如 <code>{'{{$ts+30}}'}</code>、<code>{'{{$ts-60}}'}</code>；发送时按当前时刻解析
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

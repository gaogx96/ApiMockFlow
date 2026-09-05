import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 统一图标说明浮层（委托式）
 * - 全局挂载一次；监听 document 上的 mouseover/out、focusin/out。
 * - 任意带 data-tip 的元素（按钮/图标）hover 或键盘聚焦即触发，无需逐个接线。
 * - fixed 定位 + 挂到 body，规避工具条/列表容器的 overflow 裁剪。
 * - hover 350ms 延迟出现（避免划过闪烁）；聚焦立即出现；滚动/Esc 立即消失。
 * - 说明文字来自 data-tip；样式见 global.css 的 .ui-tip。
 */
interface TipState { text: string; left: number; top?: number; bottom?: number; }

export default function Tooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const timer = useRef<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

    const place = (el: HTMLElement) => {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      const rect = el.getBoundingClientRect();
      const center = Math.round(rect.left + rect.width / 2); // 居中对准图标；贴边时由 layoutEffect 微调
      // 元素在上半屏 → 提示放下方，否则放上方，尽量不出界
      if (rect.top < 48) setTip({ text, left: center, top: Math.round(rect.bottom + 8) });
      else setTip({ text, left: center, bottom: Math.round(window.innerHeight - rect.top + 8) });
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null;
      if (!el) return;
      clear();
      timer.current = window.setTimeout(() => place(el), 350);
    };
    const onOut = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.('[data-tip]')) return;
      clear();
      setTip(null);
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null;
      if (!el) return;
      clear();
      place(el);
    };
    const onDismiss = () => { clear(); setTip(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onDismiss);
    document.addEventListener('scroll', onDismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      clear();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onDismiss);
      document.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // 渲染后（绘制前）夹取：贴左/右边或顶出视口时水平/垂直微调，避免出界。
  // 关键：仅当取整后的值确实变化时才 setTip，否则亚像素溢出会导致 setTip→重渲染→再溢出的死循环（React #185）。
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    let left = tip.left;
    if (r.left < 6) left = tip.left + (6 - r.left);
    else if (r.right > vw - 6) left = tip.left - (r.right - (vw - 6));
    left = Math.round(left);
    const flipTop = tip.bottom != null && r.top < 6;
    if (left !== tip.left || flipTop) {
      setTip((t) => (t ? { ...t, left, ...(flipTop ? { top: 6, bottom: undefined } : {}) } : t));
    }
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="ui-tip" role="tooltip" style={{ left: tip.left, top: tip.top, bottom: tip.bottom }}>
      {tip.text}
    </div>,
    document.body,
  );
}

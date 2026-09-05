import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

/**
 * 关键字搜索 / 定位（石墨薄雾）
 * - 只读视图（<pre> 响应体、日志 diff）：用 <Highlight> 把匹配包进 <mark>，当前项加 search-hit-active 并打 data-search-active，
 *   由各页面用一个 effect 查询该标记并 scrollIntoView 定位。
 * - 可编辑 <textarea>：平台不支持内嵌高亮，改用 useTextareaSearch —— next/prev 时 setSelectionRange 选中并滚动到该行居中，
 *   浏览器原生高亮当前项。仅在显式跳转时选中，绝不因输入而移动光标。
 * 纯展示层，不改数据流。
 */

/** 大小写不敏感、非重叠计数 */
export function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let n = 0;
  let i = t.indexOf(q);
  while (i !== -1) { n++; i = t.indexOf(q, i + q.length); }
  return n;
}

/** 只读文本高亮：base 为本段之前已有的匹配总数，用于给每个匹配分配全局序号 */
export function Highlight({ text, query, base, activeIndex }: {
  text: string;
  query: string;
  base: number;
  activeIndex: number;
}) {
  if (!query) return <>{text}</>;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  let occ = 0;
  let idx = t.indexOf(q, 0);
  while (idx !== -1) {
    if (idx > from) out.push(<Fragment key={`t${from}`}>{text.slice(from, idx)}</Fragment>);
    const global = base + occ;
    const isActive = global === activeIndex;
    out.push(
      <mark
        key={`m${idx}`}
        className={isActive ? 'search-hit search-hit-active' : 'search-hit'}
        {...(isActive ? { 'data-search-active': 'true' } : {})}
      >
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    from = idx + query.length;
    occ++;
    idx = t.indexOf(q, from);
  }
  if (from < text.length) out.push(<Fragment key={`t${from}`}>{text.slice(from)}</Fragment>);
  return <>{out}</>;
}

/** 只读多段搜索：给定按渲染顺序排列的文本段，算出总数与每段的起始序号 */
export function useMatchNav(pieces: string[], query: string) {
  const { total, bases } = useMemo(() => {
    const b: number[] = [];
    let acc = 0;
    for (const p of pieces) { b.push(acc); acc += countMatches(p, query); }
    return { total: acc, bases: b };
  }, [pieces, query]);
  const [index, setIndex] = useState(0);
  useEffect(() => { setIndex(total ? 0 : -1); }, [total, query]);
  const next = useCallback(() => setIndex((i) => (total ? (i + 1) % total : -1)), [total]);
  const prev = useCallback(() => setIndex((i) => (total ? (i - 1 + total) % total : -1)), [total]);
  return { total, bases, index, next, prev };
}

/** 可编辑 textarea 搜索：仅在显式 next/prev 时选中并滚动到匹配，输入时不干扰光标 */
export function useTextareaSearch(ref: RefObject<HTMLTextAreaElement | null>, value: string, query: string) {
  const matches = useMemo(() => {
    const res: number[] = [];
    if (!query) return res;
    const t = value.toLowerCase();
    const q = query.toLowerCase();
    let i = t.indexOf(q);
    while (i !== -1) { res.push(i); i = t.indexOf(q, i + q.length); }
    return res;
  }, [value, query]);
  const [index, setIndex] = useState(-1);
  useEffect(() => { setIndex(-1); }, [query]);

  const select = useCallback((i: number) => {
    const el = ref.current;
    if (!el || i < 0 || i >= matches.length) return;
    const start = matches[i];
    const end = start + query.length;
    el.focus();
    el.setSelectionRange(start, end);
    const line = value.slice(0, start).split('\n').length - 1;
    const cs = getComputedStyle(el);
    let lh = parseFloat(cs.lineHeight);
    if (!lh || Number.isNaN(lh)) lh = (parseFloat(cs.fontSize) || 12) * 1.4;
    el.scrollTop = Math.max(0, line * lh - el.clientHeight / 2);
  }, [ref, matches, query, value]);

  const next = useCallback(() => {
    setIndex((i) => { const n = matches.length ? (i + 1) % matches.length : -1; select(n); return n; });
  }, [matches.length, select]);
  const prev = useCallback(() => {
    setIndex((i) => { const n = matches.length ? (i - 1 + matches.length) % matches.length : -1; select(n); return n; });
  }, [matches.length, select]);

  return { count: matches.length, index, next, prev };
}

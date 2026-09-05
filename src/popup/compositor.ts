// 扩展弹窗合成器"推迟呈现"的绕过：离散点击已把 DOM 提交（诊断实测入队 1ms、
// 处理器同步耗时 0ms），但弹窗被判定为遮挡/后台时合成器会节流出帧，导致已改好的
// 界面要等数秒才刷上屏。空 requestAnimationFrame 只排一帧会被一起延后；而一个跑在
// 合成器线程、持续约 120ms 的 transform 动画能强制它连续呈现几帧（与 showToast 的
// CSS 过渡、开 DevTools 常驻出帧同理），把被推迟的那帧顶上屏。用屏幕外 1×1 全透明
// 节点，肉眼无感，动画结束即移除。弹窗任意处出现"DOM 已改却延迟上屏"的卡顿都可复用。
export function kickCompositorPresent() {
  try {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;will-change:transform;';
    document.body.appendChild(el);
    const anim = el.animate(
      [{ transform: 'translateX(0px)' }, { transform: 'translateX(1px)' }],
      { duration: 120 }
    );
    const cleanup = () => { if (el.parentNode) el.remove(); };
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
    // 兜底：极端情况下 finish/cancel 未触发也保证清除
    setTimeout(cleanup, 400);
  } catch { /* WAAPI 不可用时静默降级 */ }
}

// Lightweight toast utility for Chrome extension popup
// Usage: showToast('message') or showToast('message', 'error')

export type ToastType = 'info' | 'success' | 'error' | 'warning';

const COLORS: Record<ToastType, { bg: string; border: string; text: string }> = {
  info:    { bg: '#e6f4ff', border: '#91caff', text: '#1677ff' },
  success: { bg: '#e6ffe6', border: '#95de64', text: '#16a34a' },
  error:   { bg: '#fee2e2', border: '#fca5a5', text: '#ef4444' },
  warning: { bg: '#fef3c7', border: '#fcd34d', text: '#d97706' },
};

const DARK_COLORS: Record<ToastType, { bg: string; border: string; text: string }> = {
  info:    { bg: '#1e3a5f', border: '#1e40af', text: '#4096ff' },
  success: { bg: '#14532d', border: '#166534', text: '#4ade80' },
  error:   { bg: '#450a0a', border: '#7f1d1d', text: '#f87171' },
  warning: { bg: '#451a03', border: '#78350f', text: '#fbbf24' },
};

export function showToast(message: string, type: ToastType = 'info', duration = 3000) {
  const isDark = document.documentElement.classList.contains('dark');
  const colors = isDark ? DARK_COLORS[type] : COLORS[type];

  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
    z-index: 999999; pointer-events: none;
    background: ${colors.bg}; border: 1px solid ${colors.border}; color: ${colors.text};
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    animation: toast-in 0.2s ease;
  `;

  // Add animation keyframes if not already present
  if (!document.getElementById('toast-style')) {
    const style = document.createElement('style');
    style.id = 'toast-style';
    style.textContent = `
      @keyframes toast-in { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
      @keyframes toast-out { from { opacity: 1; } to { opacity: 0; transform: translateX(-50%) translateY(8px); } }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toast-out 0.2s ease forwards';
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// Custom confirm dialog (returns Promise<boolean>)
export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 999999;
      background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center;
    `;

    const isDark = document.documentElement.classList.contains('dark');
    const bg = isDark ? '#1f2937' : '#ffffff';
    const textColor = isDark ? '#e5e7eb' : '#1f2937';
    const borderColor = isDark ? '#4b5563' : '#e5e7eb';

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: ${bg}; border: 1px solid ${borderColor}; border-radius: 8px;
      padding: 20px; max-width: 280px; width: 90%; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    `;
    dialog.innerHTML = `
      <p style="margin:0 0 16px; font-size:13px; color:${textColor}; line-height:1.5;">${message}</p>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="_confirm_cancel" style="padding:6px 16px; border:1px solid ${borderColor}; border-radius:6px; background:${bg}; color:${textColor}; font-size:13px; cursor:pointer;">取消</button>
        <button id="_confirm_ok" style="padding:6px 16px; border:none; border-radius:6px; background:#1677ff; color:white; font-size:13px; cursor:pointer;">确定</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };

    dialog.querySelector('#_confirm_cancel')!.addEventListener('click', () => cleanup(false));
    dialog.querySelector('#_confirm_ok')!.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
  });
}

// ApiTester 的无状态 JSX 片段。当前仅诊断条 Diagnostic：props 仅一个 diagnostic，全不闭包组件 state。
// 与 helpers.ts 一样从 ApiTester.tsx 原地搬出、行为逐字不变。JSX 自动运行时（react-jsx），无需 import React。
import { RequestDiagnostic } from '../../shared/api-types';

export function Diagnostic({ diagnostic }: { diagnostic: RequestDiagnostic | null }) {
  if (!diagnostic) return null;
  const tone = diagnostic.level === 'error'
    ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300'
    : 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300';
  return (
    <div className={`p-2 border rounded-md text-xs mb-2 ${tone}`} style={{ fontSize: 11 }}>
      <div className="font-medium">诊断：{diagnostic.title}</div>
      <div className="mt-0.5 break-all">{diagnostic.message}</div>
      {diagnostic.suggestion && <div className="mt-1 opacity-90">建议：{diagnostic.suggestion}</div>}
    </div>
  );
}

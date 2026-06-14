import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { hasError: boolean; error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Silent — no console in production
    void error; void info;
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <div className="text-4xl mb-3">&#9888;</div>
          <div className="text-sm font-semibold text-gray-700 dark:text-slate-200 mb-1">页面出错了</div>
          <div className="text-xs text-gray-500 dark:text-slate-400 mb-4 max-w-xs">
            {this.state.error?.message || '渲染过程中发生未知错误'}
          </div>
          <button
            className="btn-primary text-xs"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

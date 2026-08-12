export interface ApiRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyType: 'raw' | 'form' | 'urlencoded';
}

export interface ApiResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  duration: number;
  size: number;
}

export interface ApiHistoryItem {
  id: string;
  request: ApiRequest;
  response?: ApiResponse;
  error?: string;
  timestamp: number;
}

export interface SavedRequest {
  id: string;
  name: string;
  request: ApiRequest;
  timestamp: number;
  /** 发送时是否用浏览器当前有效 Cookie 覆盖已保存的 Cookie 头 */
  autoRefreshCookie?: boolean;
}

export interface RequestDiagnostic {
  level: 'warning' | 'error';
  title: string;
  message: string;
  suggestion?: string;
}

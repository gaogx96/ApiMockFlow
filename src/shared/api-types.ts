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
  timestamp: number;
}

export interface SavedRequest {
  id: string;
  name: string;
  request: ApiRequest;
  timestamp: number;
}

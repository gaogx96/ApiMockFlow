// ==================== 匹配相关 ====================

export type MatchType = 'exact' | 'contains' | 'regex' | 'domain';

export interface RuleMatch {
  url: string;
  matchType: MatchType;
  method: string;
  resourceType: string;
}

// ==================== 动作相关 ====================

export type ActionType =
  | 'modifyRequestUrl'
  | 'modifyRequestHeader'
  | 'modifyRequestBody'
  | 'modifyResponseHeader'
  | 'modifyResponseBody'
  | 'modifyStatusCode'
  | 'redirect'
  | 'cancel';

export type OperateType = 'set' | 'append' | 'remove' | 'replace';

export interface Action {
  type: ActionType;
  operate: OperateType;
  key: string;
  value: string;
}

// ==================== 规则 ====================

export interface Rule {
  id: string;
  name: string;
  groupId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  match: RuleMatch;
  actions: Action[];
}

// ==================== 分组 ====================

export interface RuleGroup {
  id: string;
  name: string;
  enabled: boolean;
  color: string;
}

// ==================== 全局状态 ====================

export interface AppState {
  globalEnabled: boolean;
  rules: Rule[];
  groups: RuleGroup[];
}

// ==================== 消息通信 ====================

export type MessageType =
  | 'GET_RULES'
  | 'SAVE_RULES'
  | 'SAVE_GROUPS'
  | 'TOGGLE_RULE'
  | 'TOGGLE_GROUP'
  | 'TOGGLE_GLOBAL'
  | 'GET_STATE'
  | 'GET_MATCHING_RULES'
  | 'EXPORT_RULES'
  | 'IMPORT_RULES'
  | 'DELETE_RULE'
  | 'API_TEST_REQUEST'
  | 'API_TEST_HISTORY_GET'
  | 'API_TEST_HISTORY_SAVE'
  | 'API_TEST_HISTORY_CLEAR'
  | 'API_SAVED_GET'
  | 'API_SAVED_SAVE'
  | 'API_SAVED_DELETE';

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

// ==================== 标签映射 ====================

export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  modifyRequestUrl: '修改请求 URL',
  modifyRequestHeader: '修改请求头',
  modifyRequestBody: '修改请求体',
  modifyResponseHeader: '修改响应头',
  modifyResponseBody: '修改响应体',
  modifyStatusCode: '修改状态码',
  redirect: '重定向请求',
  cancel: '拦截请求',
};

export const OPERATE_TYPE_LABELS: Record<OperateType, string> = {
  set: '设置',
  append: '追加',
  remove: '删除',
  replace: '替换',
};

export const MATCH_TYPE_LABELS: Record<MatchType, string> = {
  exact: '精确匹配',
  contains: '包含匹配',
  regex: '正则匹配',
  domain: '域名匹配',
};

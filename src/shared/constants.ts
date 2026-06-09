// 分组颜色选项
export const GROUP_COLORS = [
  '#1677ff', // primary blue
  '#16a34a', // green
  '#d97706', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
];

// 请求方法选项
export const HTTP_METHODS = [
  '',
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
];

// 资源类型选项
export const RESOURCE_TYPES = [
  '',
  'xmlhttprequest',
  'fetch',
  'script',
  'stylesheet',
  'image',
  'font',
  'document',
  'other',
];

// 生成唯一ID
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

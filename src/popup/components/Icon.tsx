import type { ComponentType, SVGProps } from 'react';
import {
  Activity, AlertTriangle, ArrowRightToLine, Bookmark, BookmarkX, Braces, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  ClipboardList, ClipboardPaste, Clock3, Copy, Download, ExternalLink, Eye, EyeOff, FileSearch,
  FlaskConical, FolderInput, GitCompareArrows, KeyRound, List, ListFilter, ListTree, Maximize2, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Plus,
  Repeat2, RefreshCw, Search, Send, Settings, ShieldAlert, ShieldCheck, Sun, Table2, Tag, Trash2, Upload,
  Wrench, X, Zap,
} from 'lucide-react';

/**
 * 统一图标封装（石墨薄雾规范）
 * - 单一来源：语义名 → lucide 组件；仅登记实际用到的图标以保 tree-shaking。
 * - 统一 strokeWidth 1.5；尺寸约定 14 / 16 / 18（特例：12 微型关闭、24/32 空状态）。
 * - color 继承 currentColor；装饰图标默认 aria-hidden，
 *   一旦调用方传入 aria-label（有独立语义的图标）则自动移除 aria-hidden。
 */
export type IconName =
  | 'activity' | 'alert-triangle' | 'arrow-right-to-line' | 'bookmark' | 'bookmark-x' | 'braces' | 'check' | 'chevron-down' | 'chevron-left'
  | 'chevron-right' | 'chevron-up' | 'clipboard-list' | 'clipboard-paste' | 'clock-3' | 'copy' | 'download'
  | 'external-link' | 'eye' | 'eye-off' | 'file-search' | 'flask-conical' | 'folder-input' | 'git-compare-arrows'
  | 'key-round' | 'list' | 'list-filter' | 'list-tree' | 'maximize-2' | 'moon' | 'panel-left-close' | 'panel-left-open' | 'pencil' | 'plus' | 'repeat-2'
  | 'refresh-cw' | 'search' | 'send' | 'settings' | 'shield-alert' | 'shield-check' | 'sun' | 'table-2' | 'tag'
  | 'trash-2' | 'upload' | 'wrench' | 'x' | 'zap';

const REGISTRY: Record<IconName, ComponentType<SVGProps<SVGSVGElement>>> = {
  activity: Activity, 'alert-triangle': AlertTriangle, 'arrow-right-to-line': ArrowRightToLine, bookmark: Bookmark, 'bookmark-x': BookmarkX, braces: Braces, check: Check,
  'chevron-down': ChevronDown, 'chevron-left': ChevronLeft, 'chevron-right': ChevronRight,
  'chevron-up': ChevronUp, 'clipboard-list': ClipboardList, 'clipboard-paste': ClipboardPaste, 'clock-3': Clock3, copy: Copy,
  download: Download, 'external-link': ExternalLink, eye: Eye, 'eye-off': EyeOff,
  'file-search': FileSearch, 'flask-conical': FlaskConical, 'folder-input': FolderInput, 'git-compare-arrows': GitCompareArrows,
  'key-round': KeyRound, list: List, 'list-filter': ListFilter, 'list-tree': ListTree, 'maximize-2': Maximize2, moon: Moon,
  'panel-left-close': PanelLeftClose, 'panel-left-open': PanelLeftOpen,
  pencil: Pencil,
  plus: Plus, 'repeat-2': Repeat2, 'refresh-cw': RefreshCw, search: Search, send: Send,
  settings: Settings, 'shield-alert': ShieldAlert, 'shield-check': ShieldCheck, sun: Sun, 'table-2': Table2, tag: Tag,
  'trash-2': Trash2, upload: Upload, wrench: Wrench, x: X, zap: Zap,
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: 12 | 14 | 16 | 18 | 24 | 32 | number;
}

export default function Icon({ name, size = 14, strokeWidth = 1.5, ...props }: IconProps) {
  const Component = REGISTRY[name];
  const ariaHidden = props['aria-label'] == null ? true : undefined;
  return <Component width={size} height={size} strokeWidth={strokeWidth} aria-hidden={ariaHidden} {...props} />;
}

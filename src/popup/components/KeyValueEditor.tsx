import Icon from './Icon';

export interface KVField {
  name: string;
  value: string;
}

interface Props {
  fields: KVField[];
  onChange: (next: KVField[]) => void;
  /** 面板高度（px），由外部按 tab/类型持久化 */
  height: number;
  /** 用户拖拽 resize 后回传新的高度 */
  onHeightChange: (px: number) => void;
  /** 点击「+」新增字段（外部负责在新增前顺带撑高面板） */
  onAdd: () => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

/**
 * 键值编辑器（石墨薄雾）：Key / Value 行 + 增删，可拖拽调整高度。
 * 供 ApiTester 的 multipart / urlencoded 请求体复用，消除两处近乎重复的内联实现。
 */
export default function KeyValueEditor({
  fields, onChange, height, onHeightChange, onAdd,
  keyPlaceholder = '字段名', valuePlaceholder = '字段值',
}: Props) {
  return (
    <div
      className="flex flex-col border border-gray-200 dark:border-slate-700 rounded-[10px] overflow-y-auto resize-y min-h-[92px]"
      style={{ height, maxHeight: 'calc(100vh - 215px)' }}
      onMouseUp={(e) => onHeightChange(e.currentTarget.offsetHeight)}
    >
      <div className="sticky top-0 z-10 grid grid-cols-[minmax(110px,1fr)_minmax(0,2fr)_28px] gap-1.5 px-2 py-1 bg-gray-50 dark:bg-slate-900 text-[10px] font-medium text-gray-400 dark:text-slate-500">
        <span>Key</span>
        <span>Value</span>
        <button className="btn-ghost p-0.5" title="添加字段" aria-label="添加字段" onClick={onAdd}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div className="flex-none p-1.5 space-y-1.5">
        {fields.map((part, idx) => (
          <div key={idx} className="grid grid-cols-[minmax(110px,1fr)_minmax(0,2fr)_28px] gap-1.5 items-center">
            <input
              className="form-input min-w-0 text-xs"
              placeholder={keyPlaceholder}
              value={part.name}
              onChange={(e) => { const n = [...fields]; n[idx] = { ...part, name: e.target.value }; onChange(n); }}
            />
            <input
              className="form-input min-w-0 text-xs"
              placeholder={valuePlaceholder}
              value={part.value}
              onChange={(e) => { const n = [...fields]; n[idx] = { ...part, value: e.target.value }; onChange(n); }}
            />
            <button
              className="btn-ghost p-1"
              title="删除字段"
              aria-label="删除字段"
              onClick={() => onChange(fields.filter((_, i) => i !== idx))}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
        {fields.length === 0 && <div className="py-3 text-center text-xs text-gray-400">暂无字段</div>}
      </div>
    </div>
  );
}

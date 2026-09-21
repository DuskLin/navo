import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'

export function ModelMappingEditor({
  rows,
  models,
  onChange
}: {
  rows: [string, string][]
  models: string[]
  onChange: (rows: [string, string][]) => void
}) {
  const modelListId = useId()
  return (
    <section className="model-mappings" aria-label="模型 ID 映射">
      <div className="model-protocols-heading">
        <strong>模型 ID 映射{rows.length ? `（${rows.length}）` : ''}</strong>
        <button
          className="text-button"
          type="button"
          disabled={rows.length >= 2000}
          onClick={() => onChange([...rows, ['', '']])}
        >
          <Plus size={14} /> 添加映射
        </button>
      </div>
      <p className="model-protocols-hint">
        将客户端请求的模型 ID 转发到此账号的上游模型。精确匹配优先，再按末尾 * 匹配最长前缀，例如
        claude-* → kimi-for-coding。未命中时使用原模型 ID。
        目标须在可用模型中启用，协议和费用按目标模型处理；保存账号后生效。
      </p>
      <datalist id={modelListId}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      {rows.length > 0 && (
        <div className="model-mapping-list">
          <div className="model-mapping-row model-mapping-labels" aria-hidden="true">
            <span>请求模型 ID</span>
            <span />
            <span>上游模型 ID</span>
            <span />
          </div>
          {rows.map(([from, to], index) => (
            <div key={index}>
              <div className="model-mapping-row">
                <input
                  aria-label={`请求模型 ID ${index + 1}`}
                  placeholder="请求模型 ID，如 claude-*"
                  maxLength={200}
                  required
                  value={from}
                  onChange={(event) =>
                    onChange(rows.map((row, i) => (i === index ? [event.target.value, to] : row)))
                  }
                />
                <span aria-hidden="true">→</span>
                <input
                  aria-label={`上游模型 ID ${index + 1}`}
                  placeholder="上游模型 ID"
                  list={modelListId}
                  maxLength={200}
                  required
                  value={to}
                  onChange={(event) =>
                    onChange(rows.map((row, i) => (i === index ? [from, event.target.value] : row)))
                  }
                />
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`删除映射 ${index + 1}`}
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {to.trim() && !models.includes(to.trim()) && (
                <p className="model-protocols-hint">
                  目标当前不可用，请在上方添加或恢复此模型后使用映射。
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

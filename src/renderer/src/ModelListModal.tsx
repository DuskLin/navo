import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { AccountView, Provider } from '../../shared/contracts'
import { exposedModels, mappedModel } from '../../shared/model-mapping'
import { Modal } from './Modal'
import { ModelLogo } from './ModelLogo'

const providerNames: Record<Provider, string> = {
  kimi: 'Kimi Code',
  deepseek: 'DeepSeek',
  'opencode-go': 'OpenCode Go',
  codex: 'Codex',
  minimax: 'MiniMax',
  'commandcode-goat': 'Command Code',
  custom: '自定义供应商'
}

function groupProviders(accounts: AccountView[]) {
  const groups = new Map<Provider, AccountView[]>()
  for (const account of accounts) {
    const provider = account.provider ?? 'kimi'
    groups.set(provider, [...(groups.get(provider) ?? []), account])
  }
  return [...groups]
}

export function ModelListModal({
  accounts,
  close
}: {
  accounts: AccountView[]
  close: () => void
}) {
  const [search, setSearch] = useState('')
  const [copying, setCopying] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState('')
  const copyConfig = async (model: string) => {
    setCopying(model)
    setCopied(null)
    setCopyError('')
    try {
      await window.navo.copyKimiModelConfig(model)
      setCopied(model)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error))
    } finally {
      setCopying(null)
    }
  }
  const models = useMemo(() => {
    const sources = new Map<string, AccountView[]>()
    for (const account of accounts) {
      for (const model of exposedModels(account)) {
        sources.set(model, [...(sources.get(model) ?? []), account])
      }
    }
    return [...sources].sort(([a], [b]) => a.localeCompare(b))
  }, [accounts])
  const query = search.trim().toLowerCase()
  const filtered = models.filter(([model, sources]) =>
    [
      model,
      ...sources.flatMap((account) => [
        account.name,
        providerNames[account.provider ?? 'kimi'],
        mappedModel(account, model)
      ])
    ].some((value) => value.toLowerCase().includes(query))
  )

  return (
    <Modal
      title="模型列表"
      close={close}
      className="model-list-modal"
      beforeContent={
        <div className="model-list-toolbar">
          <p className="muted">按调用名称汇总模型，查看各来源的实际调用模型。</p>
          <input
            className="model-list-search"
            type="search"
            aria-label="搜索模型、供应商或账号"
            placeholder="搜索模型、供应商或账号…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p className="muted" role="status">
            {query
              ? `找到 ${filtered.length} / ${models.length} 个模型`
              : `共 ${models.length} 个模型`}
          </p>
        </div>
      }
      footer={
        (copying || copyError || copied) && (
          <div className="model-list-copy-feedback">
            {copying && (
              <p className="muted" role="status">
                正在生成配置…
              </p>
            )}
            {copyError && (
              <p className="model-list-copy-error" role="alert">
                {copyError}
              </p>
            )}
            {copied && (
              <p className="muted" role="status">
                已复制 {copied} 的模型配置（provider = "Navo"）。
              </p>
            )}
          </div>
        )
      }
    >
      {filtered.length ? (
        <ul className="model-list-items">
          {filtered.map(([model, sources]) => (
            <li className="model-list-item" key={model}>
              <div className="model-list-heading">
                <ModelLogo model={model} />
                <strong>{model}</strong>
                <button
                  type="button"
                  className="icon-button model-list-copy-button"
                  aria-label={`复制 ${model} 的 Kimi Code 配置`}
                  title={copied === model ? '已复制 Kimi Code 配置' : '复制 Kimi Code 配置'}
                  disabled={copying !== null}
                  onClick={() => void copyConfig(model)}
                >
                  {copied === model ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <span className="model-list-count">{sources.length} 个来源</span>
              </div>
              <table className="model-list-table" aria-label={`${model} 的供应商与映射`}>
                <thead>
                  <tr>
                    <th scope="col">供应商 / 账号</th>
                    <th scope="col">实际调用模型</th>
                  </tr>
                </thead>
                <tbody>
                  {groupProviders(sources).flatMap(([provider, providerAccounts]) =>
                    providerAccounts.map((account) => {
                      const target = mappedModel(account, model)
                      return (
                        <tr key={account.id}>
                          <td>
                            <span className="model-list-provider-name">
                              {providerNames[provider]}
                            </span>
                            <span className="model-list-account">{account.name}</span>
                            {(!account.enabled || !account.hasCredential) && (
                              <span className="model-list-status">
                                {!account.enabled ? '已停用' : '未配置凭据'}
                              </span>
                            )}
                          </td>
                          <td>
                            <span
                              className={`model-list-route ${target !== model ? 'is-mapped' : ''}`}
                            >
                              <span className="model-list-route-label">
                                {target !== model ? '映射至' : '同名直连'}
                              </span>
                              <span className="model-list-target">{target}</span>
                            </span>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          {models.length
            ? '没有匹配的模型，请尝试其他关键词。'
            : '暂无模型，请在设置中添加账号并同步模型。'}
        </div>
      )}
    </Modal>
  )
}

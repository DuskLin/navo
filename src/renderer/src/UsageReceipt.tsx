import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowDown, Check, Copy, Download, LoaderCircle, Printer, Sparkles, X } from 'lucide-react'
import {
  RECEIPT_BACKGROUNDS,
  receiptRange,
  renderUsageReceipt,
  type ReceiptDays,
  type ReceiptMode,
  type UsageReceipt as ReceiptData
} from '../../shared/usage-receipt'
import { ReceiptPaper } from './ReceiptPaper'
import './usage-receipt.css'

type Stage = 'select' | 'loading' | 'printing' | 'ready' | 'tearing' | 'preview'
const cleanError = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '操作失败，请重试'
function storedBackground() {
  try {
    const index = Number(localStorage.getItem('navo.receipt.background'))
    return Number.isInteger(index) && RECEIPT_BACKGROUNDS[index] ? index : 0
  } catch {
    return 0
  }
}

async function receiptPng(scene: ReturnType<typeof renderUsageReceipt>) {
  const picture = new Image()
  picture.src = scene.url
  await picture.decode()
  // Keep long receipts complete while bounding the bitmap allocation.
  const scale = Math.min(
    2,
    30000 / scene.height,
    Math.sqrt(30_000_000 / (scene.width * scene.height))
  )
  if (scale < 1) throw new Error('小票明细过多，请缩短统计范围后重试')
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(scene.width * scale)
  canvas.height = Math.floor(scene.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法生成小票图片，请重试')
  context.drawImage(picture, 0, 0, canvas.width, canvas.height)
  const png = canvas.toDataURL('image/png')
  canvas.width = canvas.height = 0
  if (!png.startsWith('data:image/png;')) throw new Error('小票图片生成失败')
  return png
}

export function UsageReceipt({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const operation = useRef(0)
  const [stage, setStage] = useState<Stage>('select')
  const [days, setDays] = useState<ReceiptDays>(1)
  const [receipt, setReceipt] = useState<ReceiptData>()
  const [mode, setMode] = useState<ReceiptMode>('cost')
  const [background, setBackground] = useState(storedBackground)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [exporting, setExporting] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const paper = useMemo(() => receipt && renderUsageReceipt(receipt, mode), [receipt, mode])
  const scene = useMemo(
    () => receipt && renderUsageReceipt(receipt, mode, background),
    [receipt, mode, background]
  )
  useEffect(() => {
    dialog.current?.showModal()
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query.matches)
    query.addEventListener('change', update)
    return () => {
      operation.current++
      query.removeEventListener('change', update)
    }
  }, [])
  useEffect(() => {
    if (stage !== 'printing') return
    const timer = setTimeout(() => setStage('ready'), reducedMotion ? 0 : 3200)
    return () => clearTimeout(timer)
  }, [stage, reducedMotion])

  async function generate(preview = false) {
    const current = ++operation.current
    setError('')
    setNotice('')
    setStage('loading')
    const now = Date.now()
    const range = receiptRange(days, now)
    try {
      const stats = await window.navo.getUsageStats(range)
      if (operation.current !== current) return
      if (!stats.receipt) throw new Error('小票统计暂不可用，请重试')
      setReceipt({
        start: range.start,
        end: range.end,
        generatedAt: now,
        days,
        summary: stats.summary,
        details: stats.receipt
      })
      setStage(preview || reducedMotion ? 'preview' : 'printing')
    } catch (err) {
      if (operation.current === current) {
        setError(cleanError(err))
        setStage('select')
      }
    }
  }
  async function exportImage(action: 'save' | 'copy') {
    if (!scene || !receipt || exporting) return
    setExporting(true)
    setError('')
    setNotice('')
    try {
      const d = new Date(receipt.generatedAt)
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const png = await receiptPng(scene)
      const result = await window.navo.exportUsageReceipt({
        png,
        action,
        filename: `Navo-usage-${stamp}-${receipt.days}d.png`
      })
      setNotice(
        result === 'copied' ? '图片已复制，可以粘贴分享' : result === 'saved' ? '小票已保存' : ''
      )
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setExporting(false)
    }
  }
  const printing = stage === 'printing' || stage === 'ready' || stage === 'tearing'
  return (
    <dialog
      ref={dialog}
      className={`receipt-dialog ${printing ? 'receipt-theater' : ''}`}
      aria-label="AI 用量小票"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <button className="receipt-close" type="button" aria-label="关闭小票" onClick={close}>
        <X size={19} />
      </button>
      {(stage === 'select' || stage === 'loading') && (
        <div className="receipt-intro">
          <span className="receipt-eyebrow">NAVO · USAGE RECEIPT</span>
          <div className="receipt-intro-icon">
            <Printer size={32} strokeWidth={1.4} />
          </div>
          <h2>把今天的创造，印成一张小票。</h2>
          <p>记录 AI 用量，让每一次灵感都有迹可循。</p>
          <fieldset className="receipt-range" disabled={stage === 'loading'}>
            <legend>统计范围</legend>
            {([1, 7, 30] as const).map((value) => (
              <button
                type="button"
                aria-pressed={days === value}
                onClick={() => setDays(value)}
                key={value}
              >
                {value === 1 ? '今天' : `近 ${value} 天`}
              </button>
            ))}
          </fieldset>
          <button
            type="button"
            className="receipt-primary"
            disabled={stage === 'loading'}
            onClick={() => void generate()}
          >
            {stage === 'loading' ? (
              <LoaderCircle className="receipt-spinner" size={17} />
            ) : (
              <Printer size={17} />
            )}
            {stage === 'loading' ? '正在整理用量…' : '打印我的小票'}
          </button>
          <button
            type="button"
            className="receipt-text-button"
            disabled={stage === 'loading'}
            onClick={() => void generate(true)}
          >
            直接预览
          </button>
          <small>本地生成 · 仅统计 Navo 网关已记录的用量</small>
        </div>
      )}
      {printing && paper && (
        <div className="receipt-print-stage">
          <div
            className="receipt-printer"
            style={{ '--paper-ratio': paper.width / paper.height } as CSSProperties}
          >
            <div className="receipt-slot">
              <span />
            </div>
            <div className={`receipt-paper-clip ${stage}`}>
              <ReceiptPaper
                image={paper}
                phase={stage as 'printing' | 'ready' | 'tearing'}
                reducedMotion={reducedMotion}
                onTear={() => setStage('tearing')}
                onComplete={() => setStage('preview')}
              />
            </div>
          </div>
          <div className="receipt-print-controls">
            <span aria-live="polite">
              {stage === 'printing' ? (
                <>
                  <LoaderCircle size={15} className="receipt-spinner" />
                  正在打印小票…
                </>
              ) : (
                <>
                  <ArrowDown size={15} />
                  {stage === 'tearing' ? '小票已撕下' : '拖住一角向下撕，松手可继续'}
                </>
              )}
            </span>
            {stage === 'printing' && (
              <button type="button" onClick={() => setStage('ready')}>
                跳过
              </button>
            )}
            {stage === 'ready' && (
              <button type="button" onClick={() => setStage('tearing')}>
                撕下
              </button>
            )}
            <button type="button" onClick={() => setStage('preview')}>
              直接预览
            </button>
          </div>
        </div>
      )}
      {stage === 'preview' && scene && receipt && (
        <div className="receipt-preview-layout">
          <div
            className="receipt-preview-scroll"
            tabIndex={0}
            aria-label="小票图片预览，可滚动查看完整明细"
          >
            <img
              className="receipt-scene"
              style={{ '--scene-ratio': scene.width / scene.height } as CSSProperties}
              src={scene.url}
              alt="Navo AI 用量小票预览"
            />
          </div>
          <aside className="receipt-options">
            <span className="receipt-eyebrow">YOUR DAILY FOOTPRINT</span>
            <h2>创造，值得留存。</h2>
            <p>为这份记录选一种心情。</p>
            <fieldset className="receipt-mode" disabled={exporting}>
              <legend>小票主数字</legend>
              <button
                type="button"
                aria-pressed={mode === 'cost'}
                onClick={() => {
                  setMode('cost')
                  setNotice('')
                }}
              >
                费用
              </button>
              <button
                type="button"
                aria-pressed={mode === 'tokens'}
                onClick={() => {
                  setMode('tokens')
                  setNotice('')
                }}
              >
                Token
              </button>
            </fieldset>
            <fieldset className="receipt-backgrounds" disabled={exporting}>
              <legend>背景</legend>
              <div>
                {RECEIPT_BACKGROUNDS.map((bg, i) => (
                  <button
                    type="button"
                    key={bg.name}
                    aria-label={bg.name}
                    aria-pressed={background === i}
                    title={bg.name}
                    style={{ background: `linear-gradient(135deg, ${bg.from}, ${bg.to})` }}
                    onClick={() => {
                      setBackground(i)
                      setNotice('')
                      try {
                        localStorage.setItem('navo.receipt.background', String(i))
                      } catch {
                        /* Selection still works without storage. */
                      }
                    }}
                  >
                    {background === i && <Check size={19} />}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="receipt-export-actions">
              <button
                type="button"
                className="receipt-primary"
                disabled={exporting}
                onClick={() => void exportImage('save')}
              >
                {exporting ? (
                  <LoaderCircle className="receipt-spinner" size={16} />
                ) : (
                  <Download size={16} />
                )}
                保存图片
              </button>
              <button
                type="button"
                className="receipt-secondary"
                disabled={exporting}
                onClick={() => void exportImage('copy')}
              >
                <Copy size={16} />
                复制图片
              </button>
            </div>
            <small>
              <Sparkles size={13} />
              高清 PNG · 保留完整明细
            </small>
            <button
              type="button"
              className="receipt-text-button"
              disabled={exporting}
              onClick={() => {
                setStage('select')
                setError('')
                setNotice('')
              }}
            >
              重新选择统计范围
            </button>
          </aside>
        </div>
      )}
      {(error || notice) && (
        <p
          className={`receipt-message ${error ? 'is-error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error || notice}
        </p>
      )}
    </dialog>
  )
}

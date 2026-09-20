import { BrainCircuit } from 'lucide-react'
import { modelBrand, type ModelBrand } from '../../shared/model-brand'
import kimi from './assets/models/kimi-color.svg'
import grok from './assets/models/grok.svg'
import deepseek from './assets/models/deepseek-color.svg'
import qwen from './assets/models/qwen-color.svg'
import zai from './assets/models/zai.svg'
import minimax from './assets/models/minimax-color.svg'
import longcat from './assets/models/longcat-color.svg'
import mimo from './assets/models/xiaomimimo.svg'
import hunyuan from './assets/models/hunyuan-color.svg'
import openai from './assets/models/openai.svg'
import meta from './assets/models/meta-color.svg'
import opencode from './assets/models/opencode.svg'
import claude from './assets/models/claude-color.svg'
import gemini from './assets/models/gemini-color.svg'

const logos: Record<ModelBrand, string> = {
  kimi,
  grok,
  deepseek,
  qwen,
  zai,
  minimax,
  longcat,
  mimo,
  hunyuan,
  openai,
  meta,
  opencode,
  claude,
  gemini
}
export function ModelLogo({ model }: { model: string }) {
  const brand = modelBrand(model)
  return brand ? (
    <img
      className={`model-logo${brand === 'openai' ? ' openai-logo' : ''}`}
      data-brand={brand}
      src={logos[brand]}
      alt={`${model} Logo`}
      title={brand === 'opencode' ? 'OpenCode 平台图标（暂无独立模型图标）' : undefined}
      draggable={false}
    />
  ) : (
    <BrainCircuit size={27} />
  )
}

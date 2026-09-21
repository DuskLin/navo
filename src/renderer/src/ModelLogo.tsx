import { BrainCircuit } from 'lucide-react'
import { modelBrand, type ModelBrand } from '../../shared/model-brand'
import grok from './assets/models/grok.svg'
import deepseek from './assets/models/deepseek.svg'
import qwen from './assets/models/qwen.svg'
import zai from './assets/models/zai.svg'
import minimax from './assets/models/minimax.svg'
import longcat from './assets/models/longcat.svg'
import mimo from './assets/models/xiaomimimo.svg'
import hunyuan from './assets/models/hunyuan.svg'
import openai from './assets/models/openai.svg'
import meta from './assets/models/meta.svg'
import opencode from './assets/models/opencode.svg'
import claude from './assets/models/anthropic.svg'
import gemini from './assets/models/gemini.svg'

import huawei from './assets/models/huawei.svg'
import spark from './assets/models/spark.svg'
import stepfun from './assets/models/stepfun.svg'
import doubao from './assets/models/doubao.svg'

const logos: Record<Exclude<ModelBrand, 'kimi'>, string> = {
  huawei,
  spark,
  stepfun,
  doubao,
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
  if (brand === 'kimi') {
    return (
      <svg
        className="model-logo"
        data-brand="kimi"
        width="27"
        height="27"
        viewBox="0 0 24 24"
        role="img"
        aria-label={`${model} Logo`}
      >
        <path
          d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"
          fill="#1783FF"
        />
        <path
          d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"
          fill="currentColor"
        />
      </svg>
    )
  }
  return brand ? (
    <img
      className="model-logo monochrome-logo"
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

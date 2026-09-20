import zai from './assets/harness/zai.svg'
import kimi from './assets/harness/kimi-color.svg'
import claude from './assets/harness/claudecode-color.svg'
import codex from './assets/models/openai.svg'
import qoder from './assets/harness/qoder-color.svg'
import codebuddy from './assets/harness/codebuddy-color.svg'
import pi from './assets/harness/pi.svg'
import deepseek from './assets/harness/deepseek-color.svg'
import cline from './assets/harness/cline.svg'

// Zcode / WorkBuddy use parent-brand assets; this icon set has no standalone marks.
const logos: Record<string, string> = {
  Zcode: zai,
  'Kimi Code': kimi,
  'Claude Code': claude,
  Claude: claude,
  Codex: codex,
  Qoder: qoder,
  WorkBuddy: codebuddy,
  Pi: pi,
  'DeepSeek Harness': deepseek,
  Cline: cline
}

export function HarnessLogo({ name }: { name: string }) {
  const src = logos[name]
  return src ? (
    <img
      className={`flow-harness-logo${name === 'Codex' ? ' openai-logo' : ''}`}
      data-brand={name}
      src={src}
      alt={`${name} Logo`}
      draggable={false}
    />
  ) : (
    <>{name === '未知客户端' ? '?' : name.slice(0, 1)}</>
  )
}

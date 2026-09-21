import zai from './assets/models/zai.svg'
import kimi from './assets/harness/kimi-color.svg'
import claude from './assets/harness/claudecode.svg'
import codex from './assets/models/openai.svg'
import qoder from './assets/harness/qoder.svg'
import codebuddy from './assets/harness/codebuddy.svg'
import pi from './assets/harness/pi.svg'
import deepseek from './assets/models/deepseek.svg'
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
      className={`flow-harness-logo${name !== 'Kimi Code' ? ' monochrome-logo' : ''}`}
      data-brand={name}
      src={src}
      alt={`${name} Logo`}
      draggable={false}
    />
  ) : (
    <>{name === '未知客户端' ? '?' : name.slice(0, 1)}</>
  )
}

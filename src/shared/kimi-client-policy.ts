import type { AccountInput } from './contracts'

/** A client-declared UA check, not proof of client identity. Never rewrite the UA. */
export function isKimiUserAgent(value: string | undefined): boolean {
  return (
    !!value &&
    /^(?:KimiCLI|kimi|kimi-cli|kimi-code|kimi-code-cli|kimi-code-desktop|kimi-code-vscode|kimi_code)\/[a-z0-9][a-z0-9.+_-]*(?:\s|$)/i.test(
      value
    )
  )
}

export function requiresKimiUserAgent(
  account: Pick<AccountInput, 'provider' | 'kind' | 'kimiOAuthOnly'>
): boolean {
  return account.provider === 'kimi' && account.kind === 'oauth' && account.kimiOAuthOnly !== false
}

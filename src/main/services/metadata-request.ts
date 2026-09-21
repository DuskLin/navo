import { net } from 'electron'

// Account discovery and OAuth must use the desktop's system proxy/PAC and trust store.
// Node's global fetch uses a separate network stack and can fail while Kimi Code works.
export const metadataRequest: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.href : input, {
    ...init,
    credentials: 'omit',
    cache: 'no-store'
  })

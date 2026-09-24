import { BrowserWindow, clipboard, ClipboardItem, dialog, nativeImage } from 'electron'
import { writeFile } from 'node:fs/promises'

const busy = new Set<number>()
export async function exportUsageReceipt(value: unknown, sender: Electron.WebContents) {
  if (!value || typeof value !== 'object') throw new Error('小票导出参数无效')
  const { png, action, filename } = value as Record<string, unknown>
  if (
    (action !== 'save' && action !== 'copy') ||
    typeof filename !== 'string' ||
    !/^Navo-usage-\d{4}-\d{2}-\d{2}-(1|7|30)d\.png$/.test(filename) ||
    typeof png !== 'string' ||
    png.length > 32 * 1024 * 1024 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(png)
  )
    throw new Error('小票图片格式或大小无效')
  if (busy.has(sender.id)) throw new Error('小票正在导出，请稍候')
  busy.add(sender.id)
  try {
    const bytes = Buffer.from(png.slice('data:image/png;base64,'.length), 'base64')
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw new Error('小票 PNG 无效')
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20)
    if (!width || !height || width > 4096 || height > 30000 || width * height > 32_000_000)
      throw new Error('小票过长，请缩短统计范围后重试')
    const picture = nativeImage.createFromBuffer(bytes)
    if (picture.isEmpty()) throw new Error('小票图片读取失败')
    if (action === 'copy') {
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([new Uint8Array(picture.toPNG())], { type: 'image/png' })
        })
      ])
      return 'copied' as const
    }
    const parent = BrowserWindow.fromWebContents(sender)
    if (!parent) throw new Error('小票窗口已关闭')
    const result = await dialog.showSaveDialog(parent, {
      title: '保存 AI 用量小票',
      defaultPath: filename,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return 'cancelled' as const
    await writeFile(result.filePath, picture.toPNG())
    return 'saved' as const
  } finally {
    busy.delete(sender.id)
  }
}

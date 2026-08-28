/** Render a compact QR without ANSI colors so TUI dialogs can display it verbatim. */
export async function renderTerminalQr(text: string): Promise<string> {
  try {
    const qrcode = await import('qrcode')
    return await qrcode.toString(text, { type: 'utf8' })
  } catch {
    return ''
  }
}

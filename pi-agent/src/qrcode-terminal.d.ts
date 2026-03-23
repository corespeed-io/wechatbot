declare module 'qrcode-terminal' {
  function generate(url: string, options?: { small?: boolean }, callback?: (qr: string) => void): void
  export default { generate }
}

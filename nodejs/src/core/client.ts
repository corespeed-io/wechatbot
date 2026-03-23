import { TypedEmitter, type BotEventMap } from './events.js'
import { NoContextError } from './errors.js'

import { Authenticator, type Credentials, type QrLoginCallbacks } from '../auth/index.js'
import { createLogger, type Logger, type LogLevel } from '../logger/index.js'
import {
  MediaDownloader,
  MediaUploader,
  type UploadOptions,
  type UploadResult,
  categorizeByMime,
  getMimeFromFilename,
  downloadFromUrl,
  silkToWav,
} from '../media/index.js'
import { MessageBuilder, MessageParser, type IncomingMessage } from '../message/index.js'
import { MiddlewareEngine, type Middleware } from '../middleware/index.js'
import { ContextStore, MessagePoller, MessageSender, TypingService } from '../messaging/index.js'
import { ILinkApi } from '../protocol/api.js'
import { DEFAULT_BASE_URL, MediaType, type CDNMedia } from '../protocol/types.js'
import { FileStorage, MemoryStorage, type Storage } from '../storage/index.js'
import { HttpClient } from '../transport/http.js'

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

export interface WeChatBotOptions {
  /** Base URL for the iLink API (default: https://ilinkai.weixin.qq.com) */
  baseUrl?: string
  /** Storage backend: 'file', 'memory', or a custom Storage instance */
  storage?: 'file' | 'memory' | Storage
  /** Directory for file storage (only used when storage is 'file') */
  storageDir?: string
  /** Log level */
  logLevel?: LogLevel
  /** Custom logger instance */
  logger?: Logger
  /** QR login callbacks (for rendering QR codes, etc.) */
  loginCallbacks?: QrLoginCallbacks
}

// ═══════════════════════════════════════════════════════════════════════
// Send options — unified type for all send/reply methods
// ═══════════════════════════════════════════════════════════════════════

/**
 * What to send. Exactly one of text/image/file/video/url must be provided.
 *
 * @example
 *   // Text
 *   await bot.reply(msg, { text: 'Hello!' })
 *
 *   // Image with caption
 *   await bot.reply(msg, { image: imgBuffer, caption: 'Here you go' })
 *
 *   // File
 *   await bot.reply(msg, { file: pdfBuffer, fileName: 'report.pdf' })
 *
 *   // Video
 *   await bot.reply(msg, { video: videoBuffer, caption: 'Check this out' })
 *
 *   // Auto-detect type from filename
 *   await bot.reply(msg, { file: data, fileName: 'photo.png' })  // → sent as image
 *
 *   // Remote URL (auto-download + auto-detect type)
 *   await bot.reply(msg, { url: 'https://example.com/photo.jpg' })
 */
export type SendContent =
  | string
  | { text: string }
  | { image: Buffer; caption?: string }
  | { video: Buffer; caption?: string }
  | { file: Buffer; fileName: string; caption?: string }
  | { url: string; fileName?: string; caption?: string }

// ═══════════════════════════════════════════════════════════════════════
// Download result
// ═══════════════════════════════════════════════════════════════════════

export interface DownloadedMedia {
  data: Buffer
  type: 'image' | 'file' | 'video' | 'voice'
  fileName?: string
  /** Voice format after transcoding: 'wav' or 'silk' */
  format?: string
}

// ═══════════════════════════════════════════════════════════════════════
// Main Client
// ═══════════════════════════════════════════════════════════════════════

/**
 * WeChatBot — the main entry point.
 *
 * ## Quick Start
 *
 * ```typescript
 * const bot = new WeChatBot()
 * await bot.login()
 *
 * bot.onMessage(async (msg) => {
 *   // Simple text reply
 *   await bot.reply(msg, 'Echo: ' + msg.text)
 *
 *   // Image reply
 *   await bot.reply(msg, { image: imgBuffer, caption: 'Here!' })
 *
 *   // File reply (auto-routes: .png → image, .mp4 → video, .pdf → file)
 *   await bot.reply(msg, { file: data, fileName: 'report.pdf' })
 *
 *   // Send from URL
 *   await bot.reply(msg, { url: 'https://example.com/photo.jpg' })
 *
 *   // Download media from incoming message
 *   const media = await bot.download(msg)
 *   if (media) console.log(media.type, media.data.length)
 * })
 *
 * await bot.start()
 * ```
 */
export class WeChatBot extends TypedEmitter<BotEventMap> {
  // ── Public components (accessible for advanced use) ─────────────────
  readonly logger: Logger
  readonly storage: Storage
  readonly uploader: MediaUploader
  readonly downloader: MediaDownloader

  // ── Internal services ───────────────────────────────────────────────
  private readonly http: HttpClient
  private readonly api: ILinkApi
  private readonly auth: Authenticator
  private readonly parser: MessageParser
  private readonly middleware: MiddlewareEngine
  private readonly contextStore: ContextStore
  private readonly poller: MessagePoller
  private readonly sender: MessageSender
  private readonly typing: TypingService

  // ── State ───────────────────────────────────────────────────────────
  private baseUrl: string
  private credentials?: Credentials
  private messageHandlers: Array<(msg: IncomingMessage) => void | Promise<void>> = []
  private runPromise: Promise<void> | null = null

  constructor(options: WeChatBotOptions = {}) {
    super()

    // Initialize foundational components
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.logger = options.logger ?? createLogger({ level: options.logLevel ?? 'info' })
    this.storage = resolveStorage(options)

    // Build the layered architecture
    this.http = new HttpClient({ logger: this.logger })
    this.api = new ILinkApi(this.http)
    this.auth = new Authenticator(this.api, this.storage, this.logger)
    this.parser = new MessageParser()
    this.middleware = new MiddlewareEngine()
    this.contextStore = new ContextStore(this.storage, this.logger)
    this.poller = new MessagePoller(this.api, this.storage, this.logger)
    this.sender = new MessageSender(this.api, this.contextStore, this.logger)
    this.typing = new TypingService(this.api, this.contextStore, this.logger)
    this.uploader = new MediaUploader(this.api, undefined, this.logger)
    this.downloader = new MediaDownloader(undefined, this.logger)

    // Wire up internal events
    this.setupPollerEvents()
  }

  // ═══════════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Login to WeChat. Uses stored credentials if available, otherwise starts QR flow.
   */
  async login(options: { force?: boolean; callbacks?: QrLoginCallbacks } = {}): Promise<Credentials> {
    const creds = await this.auth.login({
      force: options.force,
      baseUrl: this.baseUrl,
      callbacks: options.callbacks,
    })

    this.setCredentials(creds)
    this.emit('login', creds)
    return creds
  }

  /** Get current credentials (undefined if not logged in). */
  getCredentials(): Credentials | undefined {
    return this.credentials
  }

  // ═══════════════════════════════════════════════════════════════════
  // Middleware
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register middleware for the message processing pipeline.
   * Middleware runs before message handlers, in order of registration.
   *
   * @example
   *   bot.use(loggingMiddleware(bot.logger))
   *   bot.use(rateLimitMiddleware({ maxMessages: 10, windowMs: 60_000 }))
   */
  use(middleware: Middleware): this {
    this.middleware.use(middleware)
    return this
  }

  // ═══════════════════════════════════════════════════════════════════
  // Message Handlers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register a message handler.
   * Called after middleware for every incoming user message.
   */
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): this {
    this.messageHandlers.push(handler)
    return this
  }

  /**
   * Event-style alias for onMessage.
   */
  on(event: 'message', handler: (msg: IncomingMessage) => void | Promise<void>): this
  on<K extends keyof BotEventMap>(event: K, handler: (...args: BotEventMap[K]) => void | Promise<void>): this
  on(event: string, handler: (...args: any[]) => void | Promise<void>): this {
    if (event === 'message') {
      return this.onMessage(handler as (msg: IncomingMessage) => void | Promise<void>)
    }
    return super.on(event as keyof BotEventMap, handler as any)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Sending — two methods: reply() and send()
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Reply to an incoming message.
   * Automatically uses the correct context_token and cancels typing.
   *
   * @example
   *   // Text
   *   await bot.reply(msg, 'Hello!')
   *   await bot.reply(msg, { text: 'Hello!' })
   *
   *   // Image with optional caption
   *   await bot.reply(msg, { image: pngBuffer, caption: 'Screenshot' })
   *
   *   // File (auto-routes by extension: .png → image, .mp4 → video, else → file)
   *   await bot.reply(msg, { file: data, fileName: 'report.pdf' })
   *   await bot.reply(msg, { file: data, fileName: 'photo.png' })  // sent as image
   *
   *   // Video
   *   await bot.reply(msg, { video: mp4Buffer })
   *
   *   // From URL (auto-download, auto-detect type)
   *   await bot.reply(msg, { url: 'https://example.com/image.jpg' })
   */
  async reply(message: IncomingMessage, content: SendContent): Promise<void> {
    const creds = this.requireCredentials()
    this.contextStore.set(message.userId, message._contextToken)

    await this.sendContent(
      message.userId,
      message._contextToken,
      content,
    )

    this.typing.stopTyping(creds.baseUrl, creds.token, message.userId).catch(() => {})
  }

  /**
   * Send content to a user by ID.
   * Requires a prior context_token from that user (i.e., they messaged you first).
   *
   * Same content options as reply().
   *
   * @example
   *   await bot.send(userId, 'Hello!')
   *   await bot.send(userId, { image: buffer })
   *   await bot.send(userId, { file: data, fileName: 'doc.pdf' })
   *   await bot.send(userId, { url: 'https://example.com/img.png' })
   */
  async send(userId: string, content: SendContent): Promise<void> {
    const ctx = this.contextStore.get(userId)
    if (!ctx) throw new NoContextError(userId)
    await this.sendContent(userId, ctx, content)
  }

  /**
   * Send a pre-built message payload (advanced use with MessageBuilder).
   */
  async sendRaw(payload: ReturnType<MessageBuilder['build']>): Promise<void> {
    const creds = this.requireCredentials()
    await this.sender.sendRaw(creds.baseUrl, creds.token, payload)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Downloading — one method: download()
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Download media from an incoming message.
   *
   * Detects and downloads the first media item found.
   * Priority: image > file > video > voice.
   * Voice is auto-transcoded from SILK to WAV (if silk-wasm is installed).
   *
   * Returns null if the message has no media.
   *
   * @example
   *   bot.onMessage(async (msg) => {
   *     const media = await bot.download(msg)
   *     if (media) {
   *       console.log(media.type)     // 'image' | 'file' | 'video' | 'voice'
   *       console.log(media.data)     // Buffer
   *       console.log(media.fileName) // 'report.pdf' (for files)
   *       console.log(media.format)   // 'wav' | 'silk' (for voice)
   *     }
   *   })
   */
  async download(message: IncomingMessage): Promise<DownloadedMedia | null> {
    // Image
    const img = message.images[0]
    if (img?.media) {
      const data = await this.downloader.download(img.media, img.aeskey)
      return { data, type: 'image' }
    }

    // File
    const file = message.files[0]
    if (file?.media) {
      const data = await this.downloader.download(file.media)
      return { data, type: 'file', fileName: file.fileName ?? 'file.bin' }
    }

    // Video
    const video = message.videos[0]
    if (video?.media) {
      const data = await this.downloader.download(video.media)
      return { data, type: 'video' }
    }

    // Voice (auto-transcode)
    const voice = message.voices[0]
    if (voice?.media) {
      const silkBuf = await this.downloader.download(voice.media)
      const wav = await silkToWav(silkBuf, this.logger)
      if (wav) return { data: wav, type: 'voice', format: 'wav' }
      return { data: silkBuf, type: 'voice', format: 'silk' }
    }

    return null
  }

  /**
   * Download and decrypt a media file from a raw CDN reference.
   * For advanced use when you need direct access to CDNMedia objects.
   */
  async downloadRaw(media: CDNMedia, aeskeyOverride?: string): Promise<Buffer> {
    return this.downloader.download(media, aeskeyOverride)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Upload (advanced)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Upload a file to WeChat CDN and return the CDN reference.
   * Does NOT send a message — use reply()/send() for the full pipeline.
   * For advanced use when you need to compose complex messages via MessageBuilder.
   */
  async upload(options: UploadOptions): Promise<UploadResult> {
    const creds = this.requireCredentials()
    return this.uploader.upload(creds.baseUrl, creds.token, options)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Typing
  // ═══════════════════════════════════════════════════════════════════

  /** Show "typing..." indicator to a user. */
  async sendTyping(userId: string): Promise<void> {
    const creds = this.requireCredentials()
    await this.typing.startTyping(creds.baseUrl, creds.token, userId)
  }

  /** Cancel "typing..." indicator for a user. */
  async stopTyping(userId: string): Promise<void> {
    const creds = this.requireCredentials()
    await this.typing.stopTyping(creds.baseUrl, creds.token, userId)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Start receiving messages (long-poll loop).
   * Call login() first if not already authenticated.
   */
  async start(): Promise<void> {
    if (this.runPromise) return this.runPromise

    const creds = this.requireCredentials()

    // Load persisted state
    await Promise.all([
      this.contextStore.load(),
      this.poller.loadCursor(),
    ])

    this.emit('poll:start')
    this.runPromise = this.poller.start(creds.baseUrl, creds.token)

    try {
      await this.runPromise
    } finally {
      this.runPromise = null
      this.emit('poll:stop')
    }
  }

  /**
   * Convenience method: login + start in one call.
   * Equivalent to `await bot.login(); await bot.start()`.
   */
  async run(options?: { force?: boolean; callbacks?: QrLoginCallbacks }): Promise<void> {
    await this.login(options)
    await this.start()
  }

  /** Stop the bot gracefully. */
  stop(): void {
    this.poller.stop()
    this.contextStore.flush().catch(() => {})
    this.emit('close')
  }

  /** Whether the bot is currently polling for messages. */
  get isRunning(): boolean {
    return this.poller.isRunning
  }

  // ═══════════════════════════════════════════════════════════════════
  // Utility
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Create a MessageBuilder for composing complex messages.
   */
  createMessage(userId: string): MessageBuilder {
    const ctx = this.contextStore.get(userId)
    if (!ctx) throw new NoContextError(userId)
    return MessageBuilder.to(userId, ctx)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal: unified send pipeline
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Core send implementation. All public send methods route through here.
   */
  private async sendContent(
    userId: string,
    contextToken: string,
    content: SendContent,
  ): Promise<void> {
    const creds = this.requireCredentials()

    // String shorthand → text
    if (typeof content === 'string') {
      await this.sender.sendText(creds.baseUrl, creds.token, userId, content, contextToken)
      return
    }

    // { text }
    if ('text' in content) {
      await this.sender.sendText(creds.baseUrl, creds.token, userId, content.text, contextToken)
      return
    }

    // { url } → download then re-route
    if ('url' in content) {
      const result = await downloadFromUrl(content.url, { logger: this.logger })
      const fileName = content.fileName ?? result.filename
      return this.sendContent(userId, contextToken, {
        file: result.data,
        fileName,
        caption: content.caption,
      })
    }

    // { image }
    if ('image' in content) {
      await this.sendMediaBuffer(creds, userId, contextToken, content.image, MediaType.IMAGE, (builder, result) => {
        builder.image({ media: result.media, midSize: result.encryptedFileSize })
      }, content.caption)
      return
    }

    // { video }
    if ('video' in content) {
      await this.sendMediaBuffer(creds, userId, contextToken, content.video, MediaType.VIDEO, (builder, result) => {
        builder.video({ media: result.media, videoSize: result.encryptedFileSize })
      }, content.caption)
      return
    }

    // { file, fileName } — auto-route by extension
    if ('file' in content) {
      const mime = getMimeFromFilename(content.fileName)
      const category = categorizeByMime(mime)

      if (category === 'image') {
        return this.sendContent(userId, contextToken, {
          image: content.file,
          caption: content.caption,
        })
      }

      if (category === 'video') {
        return this.sendContent(userId, contextToken, {
          video: content.file,
          caption: content.caption,
        })
      }

      // Generic file
      if (content.caption) {
        await this.sender.sendText(creds.baseUrl, creds.token, userId, content.caption, contextToken)
      }
      await this.sendMediaBuffer(creds, userId, contextToken, content.file, MediaType.FILE, (builder, result) => {
        builder.file({ media: result.media, fileName: content.fileName, size: content.file.length })
      })
      return
    }
  }

  /**
   * Upload buffer to CDN and send as a message item.
   */
  private async sendMediaBuffer(
    creds: Credentials,
    userId: string,
    contextToken: string,
    data: Buffer,
    mediaType: MediaType,
    buildItem: (builder: MessageBuilder, result: UploadResult) => void,
    caption?: string,
  ): Promise<void> {
    const result = await this.uploader.upload(creds.baseUrl, creds.token, {
      data,
      userId,
      mediaType,
    })

    const builder = MessageBuilder.to(userId, contextToken)
    if (caption) builder.text(caption)
    buildItem(builder, result)
    await this.sender.sendRaw(creds.baseUrl, creds.token, builder.build())

    this.logger.info('Sent media', { userId, mediaType, size: data.length })
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal wiring
  // ═══════════════════════════════════════════════════════════════════

  private setupPollerEvents(): void {
    // Process incoming messages through the pipeline
    this.poller.on('messages', async (messages) => {
      for (const wire of messages) {
        // Always remember context tokens
        this.contextStore.remember(wire)

        // Parse to user-friendly format
        const incoming = this.parser.parse(wire)
        if (!incoming) continue

        // Run through middleware chain
        const ctx = await this.middleware.run(incoming)
        if (ctx.handled) continue

        // Dispatch to message handlers
        this.emit('message', incoming)
        await this.dispatchToHandlers(incoming)
      }

      // Persist context tokens after batch
      this.contextStore.flush().catch(() => {})
    })

    // Handle session expiry → re-login
    this.poller.on('session:expired', async () => {
      this.logger.warn('Session expired — initiating re-login')
      this.emit('session:expired')

      try {
        await this.auth.clearAll()
        this.typing.clearCache()
        const creds = await this.login({ force: true })
        this.emit('session:restored', creds)

        // Restart polling with new credentials
        await this.poller.resetCursor()
        // The poller loop will pick up new credentials automatically
      } catch (error) {
        this.logger.error(`Re-login failed: ${error instanceof Error ? error.message : String(error)}`)
        this.emit('error', error)
      }
    })

    // Forward poller errors
    this.poller.on('error', (error) => {
      this.emit('error', error)
    })
  }

  private async dispatchToHandlers(message: IncomingMessage): Promise<void> {
    const results = await Promise.allSettled(
      this.messageHandlers.map((handler) => handler(message)),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(`Handler error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        this.emit('error', result.reason)
      }
    }
  }

  private setCredentials(creds: Credentials): void {
    const previousToken = this.credentials?.token
    this.credentials = creds
    this.baseUrl = creds.baseUrl

    // If token changed, clear stale state
    if (previousToken && previousToken !== creds.token) {
      this.contextStore.clear().catch(() => {})
      this.typing.clearCache()
      this.poller.resetCursor().catch(() => {})
    }
  }

  private requireCredentials(): Credentials {
    if (!this.credentials) {
      throw new Error('Not logged in. Call login() first.')
    }
    return this.credentials
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveStorage(options: WeChatBotOptions): Storage {
  if (options.storage === undefined || options.storage === 'file') {
    return new FileStorage(options.storageDir)
  }
  if (options.storage === 'memory') {
    return new MemoryStorage()
  }
  return options.storage // Custom Storage instance
}

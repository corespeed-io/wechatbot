// ═══════════════════════════════════════════════════════════════════════
// @wechatbot/wechatbot — WeChat iLink Bot SDK
//
// A modular, extensible, production-grade SDK for building WeChat bots.
//
// Architecture layers:
//   Transport → Protocol → Services → Application
//                              ↑
//                        Middleware Chain
//
// Quick start:
//   import { WeChatBot } from '@wechatbot/wechatbot'
//
//   const bot = new WeChatBot()
//   await bot.login()
//   bot.onMessage(async (msg) => {
//     await bot.reply(msg, `Echo: ${msg.text}`)
//   })
//   await bot.start()
// ═══════════════════════════════════════════════════════════════════════

// ── Core ────────────────────────────────────────────────────────────────
export { WeChatBot, type WeChatBotOptions, type SendContent, type DownloadedMedia } from './core/client.js'
export { TypedEmitter, type BotEventMap } from './core/events.js'
export {
  ApiError,
  AuthError,
  MediaError,
  NoContextError,
  TransportError,
  WeChatBotError,
} from './core/errors.js'

// ── Auth ────────────────────────────────────────────────────────────────
export type { Credentials, QrLoginCallbacks } from './auth/types.js'

// ── Message ─────────────────────────────────────────────────────────────
export { MessageBuilder } from './message/builder.js'
export type {
  FileContent,
  ImageContent,
  IncomingMessage,
  MessageContentType,
  QuotedMessage,
  VideoContent,
  VoiceContent,
} from './message/types.js'

// ── Middleware ───────────────────────────────────────────────────────────
export { MiddlewareEngine } from './middleware/engine.js'
export {
  filterMiddleware,
  loggingMiddleware,
  rateLimitMiddleware,
  typeFilterMiddleware,
} from './middleware/builtins.js'
export type { MessageContext, Middleware, NextFunction } from './middleware/types.js'

// ── Media ───────────────────────────────────────────────────────────────
export { MediaDownloader, MediaUploader } from './media/index.js'
export type { UploadOptions, UploadResult } from './media/uploader.js'
export {
  categorizeByMime,
  getExtensionFromContentTypeOrUrl,
  getExtensionFromMime,
  getMimeFromFilename,
  type MediaCategory,
} from './media/mime.js'
export { silkToWav, SILK_SAMPLE_RATE } from './media/voice.js'
export { downloadFromUrl, type RemoteDownloadResult } from './media/remote.js'
export { stripMarkdown } from './media/markdown.js'

// ── Storage ─────────────────────────────────────────────────────────────
export { FileStorage, MemoryStorage } from './storage/index.js'
export type { Storage } from './storage/interface.js'

// ── Logger ──────────────────────────────────────────────────────────────
export { createLogger, BotLogger, StderrTransport } from './logger/logger.js'
export type { Logger, LogEntry, LogLevel, LogTransport } from './logger/types.js'

// ── Protocol (advanced) ─────────────────────────────────────────────────
export {
  MessageType,
  MessageState,
  MessageItemType,
  MediaType,
} from './protocol/types.js'
export type { CDNMedia, WireMessage, WireMessageItem } from './protocol/types.js'

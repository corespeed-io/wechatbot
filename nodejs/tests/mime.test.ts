import { describe, it, expect } from 'vitest'
import {
  getMimeFromFilename,
  getExtensionFromMime,
  getExtensionFromContentTypeOrUrl,
  categorizeByMime,
} from '../src/media/mime.js'

describe('getMimeFromFilename', () => {
  it('returns correct MIME for common extensions', () => {
    expect(getMimeFromFilename('photo.jpg')).toBe('image/jpeg')
    expect(getMimeFromFilename('photo.jpeg')).toBe('image/jpeg')
    expect(getMimeFromFilename('photo.png')).toBe('image/png')
    expect(getMimeFromFilename('photo.gif')).toBe('image/gif')
    expect(getMimeFromFilename('photo.webp')).toBe('image/webp')
    expect(getMimeFromFilename('video.mp4')).toBe('video/mp4')
    expect(getMimeFromFilename('doc.pdf')).toBe('application/pdf')
    expect(getMimeFromFilename('archive.zip')).toBe('application/zip')
    expect(getMimeFromFilename('readme.txt')).toBe('text/plain')
  })

  it('is case-insensitive', () => {
    expect(getMimeFromFilename('PHOTO.JPG')).toBe('image/jpeg')
    expect(getMimeFromFilename('Video.MP4')).toBe('video/mp4')
  })

  it('returns application/octet-stream for unknown extensions', () => {
    expect(getMimeFromFilename('file.xyz')).toBe('application/octet-stream')
    expect(getMimeFromFilename('noext')).toBe('application/octet-stream')
  })

  it('handles paths with directories', () => {
    expect(getMimeFromFilename('/path/to/photo.png')).toBe('image/png')
  })
})

describe('getExtensionFromMime', () => {
  it('returns correct extension for common MIME types', () => {
    expect(getExtensionFromMime('image/jpeg')).toBe('.jpg')
    expect(getExtensionFromMime('image/png')).toBe('.png')
    expect(getExtensionFromMime('video/mp4')).toBe('.mp4')
    expect(getExtensionFromMime('application/pdf')).toBe('.pdf')
  })

  it('handles MIME types with parameters', () => {
    expect(getExtensionFromMime('image/jpeg; charset=utf-8')).toBe('.jpg')
  })

  it('returns .bin for unknown types', () => {
    expect(getExtensionFromMime('application/x-unknown')).toBe('.bin')
  })
})

describe('getExtensionFromContentTypeOrUrl', () => {
  it('prefers Content-Type over URL', () => {
    expect(getExtensionFromContentTypeOrUrl('image/png', 'https://example.com/file.jpg')).toBe('.png')
  })

  it('falls back to URL extension', () => {
    expect(getExtensionFromContentTypeOrUrl(null, 'https://example.com/file.jpg')).toBe('.jpg')
  })

  it('returns .bin when both are unknown', () => {
    expect(getExtensionFromContentTypeOrUrl(null, 'https://example.com/noext')).toBe('.bin')
  })

  it('handles undefined Content-Type', () => {
    expect(getExtensionFromContentTypeOrUrl(undefined, 'https://example.com/photo.png')).toBe('.png')
  })
})

describe('categorizeByMime', () => {
  it('categorizes images', () => {
    expect(categorizeByMime('image/jpeg')).toBe('image')
    expect(categorizeByMime('image/png')).toBe('image')
    expect(categorizeByMime('image/webp')).toBe('image')
  })

  it('categorizes videos', () => {
    expect(categorizeByMime('video/mp4')).toBe('video')
    expect(categorizeByMime('video/quicktime')).toBe('video')
  })

  it('categorizes everything else as file', () => {
    expect(categorizeByMime('application/pdf')).toBe('file')
    expect(categorizeByMime('audio/mpeg')).toBe('file')
    expect(categorizeByMime('text/plain')).toBe('file')
    expect(categorizeByMime('application/octet-stream')).toBe('file')
  })
})

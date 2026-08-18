/**
 * Tiny but genuinely valid image files, inline so the suite needs no fixtures
 * directory. The magic-byte sniffer inspects real bytes, so these must be real
 * images rather than arbitrary buffers.
 */

/** 1x1 transparent PNG. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** 1x1 white JPEG. */
export const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** Correct RIFF/WEBP header — enough for the sniffer. */
export const WEBP_HEADER = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(18),
]);

/** A PDF. Not an image, however it labels itself. */
export const NOT_AN_IMAGE = Buffer.from('%PDF-1.4\n%fake pdf content for testing\n', 'ascii');

/** Valid PNG header followed by padding, to exceed a byte limit. */
export function oversizedPng(bytes: number): Buffer {
  return Buffer.concat([PNG_1X1, Buffer.alloc(Math.max(0, bytes - PNG_1X1.length))]);
}

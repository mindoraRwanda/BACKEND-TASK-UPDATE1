// Magic-number checks for uploaded files. The client-supplied extension and
// Content-Type are attacker-controlled, so uploads are accepted or rejected
// on the file's own leading bytes instead. Shared by admin-service (first
// gate, returns 415/413 to the browser) and user-service (re-checks before
// anything is written to disk or GridFS, so the internal route is safe even
// if it is ever called by something other than admin-service).

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ALLOWED_PHOTO_TYPES_MESSAGE =
  'Unsupported image type. Allowed types: JPEG, PNG, WebP.';
export const ALLOWED_CV_TYPES_MESSAGE =
  'Unsupported file type. Only PDF files are allowed.';

export type DetectedImageType = 'jpeg' | 'png' | 'webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** Returns the real image type from the file signature, or null. */
export function detectImageType(buf: Uint8Array): DetectedImageType | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, PNG_SIGNATURE)) return 'png';
  // WebP is a RIFF container: "RIFF" <size> "WEBP"
  if (
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }
  return null;
}

/** True when the bytes begin with the PDF header "%PDF-". */
export function isPdf(buf: Uint8Array): boolean {
  return startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

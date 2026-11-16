import { describe, expect, it } from 'vitest';
import { detectImageType, isPdf } from './file-signature.js';
import {
  listAdminTherapistsQuerySchema,
  updateTherapistProfileSchema,
} from './admin.js';

const bytes = (...b: number[]) => Uint8Array.from(b);

describe('detectImageType', () => {
  it('recognises JPEG, PNG and WebP by signature', () => {
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(
      detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    ).toBe('png');
    expect(
      detectImageType(
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.alloc(4),
          Buffer.from('WEBP'),
        ])
      )
    ).toBe('webp');
  });

  it('rejects GIF, SVG, HEIC-like, executables, RIFF that is not WebP and short input', () => {
    expect(detectImageType(Buffer.from('GIF89a....'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg></svg>'))).toBeNull();
    expect(detectImageType(Buffer.from('\0\0\0\x18ftypheic'))).toBeNull();
    expect(detectImageType(Buffer.from('MZ\x90\0'))).toBeNull();
    expect(
      detectImageType(
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.alloc(4),
          Buffer.from('WAVE'),
        ])
      )
    ).toBeNull();
    expect(detectImageType(bytes(0xff, 0xd8))).toBeNull();
    expect(detectImageType(bytes())).toBeNull();
  });
});

describe('isPdf', () => {
  it('requires the %PDF- header', () => {
    expect(isPdf(Buffer.from('%PDF-1.7'))).toBe(true);
    expect(isPdf(Buffer.from('%PDF'))).toBe(false);
    expect(isPdf(Buffer.from('MZ%PDF-'))).toBe(false);
  });
});

describe('therapist profile schemas', () => {
  it('caps cvSummary at 1500 and bio at 2000, and needs at least one field', () => {
    expect(
      updateTherapistProfileSchema.safeParse({ cvSummary: 'a'.repeat(1500) })
        .success
    ).toBe(true);
    expect(
      updateTherapistProfileSchema.safeParse({ cvSummary: 'a'.repeat(1501) })
        .success
    ).toBe(false);
    expect(
      updateTherapistProfileSchema.safeParse({ bio: 'a'.repeat(2001) }).success
    ).toBe(false);
    expect(updateTherapistProfileSchema.safeParse({}).success).toBe(false);
  });

  it('validates the admin list query', () => {
    expect(listAdminTherapistsQuerySchema.parse({}).limit).toBe(20);
    expect(
      listAdminTherapistsQuerySchema.safeParse({ missing: 'bogus' }).success
    ).toBe(false);
  });
});

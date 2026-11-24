import { z } from 'zod';

export const userRoleSchema = z.enum(['PATIENT', 'THERAPIST', 'ADMIN']);

// Emails are matched case-insensitively (RFC 5321 makes the local part
// technically case-sensitive, but virtually no real mail provider treats it
// that way, and users routinely mix casing between signup and login). The
// unique lookup in auth.routes.ts relies on this normalized form matching
// what's stored at registration time.
const normalizedEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address');

export const registerSchema = z.object({
  email: normalizedEmail,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(
      /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/,
      'Password must contain at least one letter and one number'
    ),
  role: userRoleSchema,
  userName: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100)
    .trim(),
});

export const loginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: normalizedEmail,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(
      /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/,
      'Password must contain at least one letter and one number'
    ),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type UserRoleDto = z.infer<typeof userRoleSchema>;
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

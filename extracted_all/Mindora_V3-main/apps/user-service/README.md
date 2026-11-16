# User Service

Profile management for Mindora patients and therapists.

## Prerequisites

- **Node.js 24+** (see root `.nvmrc`)

## Port

**3002** (direct) · **8000** via Kong (`/api/v1/users/*`)

## Endpoints

| Method | Path                           | Auth | Description                                     |
| ------ | ------------------------------ | ---- | ----------------------------------------------- |
| GET    | `/health`                      | No   | Health check                                    |
| GET    | `/me`                          | JWT  | Current user's profile (patient or therapist)   |
| PUT    | `/me`                          | JWT  | Update profile fields (bio, timezone, language) |
| PUT    | `/me/fcm-token`                | JWT  | Register/update FCM push token                  |
| PUT    | `/me/notification-preferences` | JWT  | Partial update of push/email/sms prefs          |
| GET    | `/{userId}/preferences`        | JWT  | Contact info + prefs (self, or SERVICE caller)  |
| GET    | `/therapists`                  | JWT  | Paginated therapist directory                   |
| GET    | `/photos/*`                    | No   | Public — serves therapist profile photos        |

`TherapistProfile.photoUrl` (nullable) — not settable through `PUT /me`; set by
an admin (admin-service upload routes) or the fallback script below. Served as
a static file from `public/therapist-photos/` via the public `/photos` route
above, deliberately outside JWT auth since an `<img>` tag can't send one.

`TherapistProfile.cvSummary` (nullable, max 1500 chars) is a short public
professional summary, returned with `bio` and `photoUrl`. The optional full CV
PDF (`cvStorageKey`, `cvFileName`, `cvSizeBytes`) is admin-only: stored in
GridFS, never in `public/`, and stripped from every public/self response via
`therapistPrivateOmit` (`src/lib/therapist-media.ts`).

## Setting a therapist photo / CV summary (fallback script)

For when the admin portal isn't available. Run from `apps/user-service`:

```bash
# Check the inputs first - touches neither the database nor the photos folder
node scripts/set-therapist-profile.mjs --photo ./photo.jpg --cv-summary ./cv-summary.txt --dry-run

# Apply (targets whatever USER_DATABASE_URL points at - check it first!)
node scripts/set-therapist-profile.mjs --user therapist@example.com   --photo ./photo.jpg --cv-summary ./cv-summary.txt
```

- `--user` is an email or a user id (UUID). `--photo` and `--cv-summary` are
  each optional, but at least one is required.
- The photo must be a real JPEG, PNG or WebP (checked by file signature, not
  extension), max 5 MB. It is copied into `public/therapist-photos/` under a
  random name; a previous photo is deleted only if the script/admin API created
  it (shared seed photos are never removed).
- The summary is plain text, max 1500 characters. Keep phone numbers, emails
  and addresses out of it: it is shown publicly.
- The image is stored as provided: no crop, resize or metadata stripping.

## Seed profiles

There's no root shortcut for auth-service's seed yet, so seed both directly:

```bash
npm run seed -w @mindora/auth-service   # 30 therapist AUTH accounts (dummy password —
                                         # NOT the patient@test.mindora.local-style logins,
                                         # see root README's Known Issues)
npm run db:seed:profiles                # 30 therapist profiles, 8 with a photoUrl
```

## Test credentials

See `apps/auth-service/README.md` for login users. Profiles are created for:

- `patient@test.mindora.local`
- `therapist@test.mindora.local`
- `therapist2@test.mindora.local`

## Docker

Build from the **repository root** (Node.js 24 Alpine):

```bash
docker build -f apps/user-service/Dockerfile -t mindora/user-service .
docker run --rm -p 3002:3002 --env-file .env mindora/user-service
```

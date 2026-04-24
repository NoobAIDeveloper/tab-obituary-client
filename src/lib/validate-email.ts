// Minimal client-side email shape check. The backend does the real
// validation — this only exists to keep the onboarding Continue button honest
// until the user has typed something that plausibly resembles an address.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

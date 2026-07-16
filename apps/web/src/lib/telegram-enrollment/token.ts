import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const START_COMMAND_PATTERN =
  /^\/start(?:@\w+)?\s+enroll_([A-Za-z0-9_-]{32})$/i;
const ENROLL_COMMAND_PATTERN = /^\/enroll(?:@\w+)?\s+([A-Za-z0-9_-]{32})$/i;

export const TELEGRAM_ENROLLMENT_TTL_MINUTES = 30;

export function generateEnrollmentToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function isEnrollmentToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashEnrollmentToken(token: string): string {
  if (!isEnrollmentToken(token)) {
    throw new Error("Invalid enrollment token format");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function extractEnrollmentToken(
  text: string | undefined,
): string | null {
  if (!text) return null;
  const normalized = text.trim();
  return (
    START_COMMAND_PATTERN.exec(normalized)?.[1] ??
    ENROLL_COMMAND_PATTERN.exec(normalized)?.[1] ??
    null
  );
}

export function buildEnrollmentCommand(token: string): string {
  if (!isEnrollmentToken(token)) {
    throw new Error("Invalid enrollment token format");
  }
  return `/start enroll_${token}`;
}

export function buildEnrollmentDeepLink(
  botUsername: string | undefined,
  token: string,
): string | null {
  if (!isEnrollmentToken(token)) {
    throw new Error("Invalid enrollment token format");
  }

  const username = botUsername?.trim().replace(/^@/, "");
  if (!username || !/^[A-Za-z0-9_]{5,32}$/.test(username)) return null;

  return `https://t.me/${username}?start=enroll_${token}`;
}

import crypto from "node:crypto";
import { ConflictError, InvalidContentError, TooLargeError } from "./errors.js";

export function sha256Of(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Returns decoded text, or throws if the bytes are binary / not valid UTF-8. */
export function assertText(buf: Buffer): string {
  if (buf.includes(0)) {
    throw new InvalidContentError("Binary content is not allowed (null byte found)");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new InvalidContentError("Content is not valid UTF-8 text");
  }
}

export function assertSize(bytes: number, max: number): void {
  if (bytes > max) {
    throw new TooLargeError(`Content is ${bytes} bytes; the limit is ${max}`);
  }
}

export function checkHash(expected: string, current: string): void {
  if (expected !== current) {
    throw new ConflictError(
      `File changed since you read it (current sha256: ${current}). Re-read the file and retry.`,
    );
  }
}


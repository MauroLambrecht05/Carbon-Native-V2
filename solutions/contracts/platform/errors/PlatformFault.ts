import type { ErrorCode } from "../types/Platform.ts";

/** Only deliberate, safe messages cross an HTTP boundary. Unknown errors do not. */
export class PlatformFault extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly fieldErrors?: Readonly<Record<string, string>>) { super(message); this.name = "PlatformFault"; }
}

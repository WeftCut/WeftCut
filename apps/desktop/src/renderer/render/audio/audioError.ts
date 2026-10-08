// Electron's console forwarding otherwise serializes DOMException as just
// "[object DOMException]", losing the information needed to diagnose playback.
export function audioErrorDetail(error: unknown): string {
  return error instanceof Error || error instanceof DOMException
    ? `${error.name}: ${error.message}`
    : String(error);
}

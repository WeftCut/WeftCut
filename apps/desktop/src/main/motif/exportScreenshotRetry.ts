import { CAPTURE_SUPERSEDED_MESSAGE, MotifCaptureTimeoutError } from '../../shared/motifs/captureErrors';

/** A screenshot timeout is a transport failure, not a content verdict.
 * doCapture tears down the failed host before rejecting. Re-run the exact
 * frame once on its fresh host, inside the existing admitted export slot.
 * Never retry script failures, other CDP phases or cancelled/stale work. */
export async function retryExportScreenshot<T>(
  capture: () => Promise<T>, current: () => boolean, onRetry: () => void,
): Promise<T> {
  if (!current()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
  try { return await capture(); }
  catch (error) {
    if (!current()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
    if (!(error instanceof MotifCaptureTimeoutError)
      || !error.message.endsWith(': Page.captureScreenshot')) throw error;
    onRetry();
    if (!current()) throw new Error(CAPTURE_SUPERSEDED_MESSAGE);
    return capture(); // Deliberately outside the catch: one retry, not a loop.
  }
}

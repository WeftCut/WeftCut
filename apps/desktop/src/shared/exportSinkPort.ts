/** Main's answer to each packed frame on the native sink's port, in frame
 * order: the count written so far, or the one failure that ends the stream. */
export type SinkPortReply = { written: number } | { error: string };

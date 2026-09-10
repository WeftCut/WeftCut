// Both renderer and MCP inference calls hold this lease until native work ends.
// Download deletion is synchronous, so no new call can race the idle check.
let readers = 0;
export function beginModelUse(): () => void {
  readers++;
  return () => { readers--; };
}
export function assertModelsIdle(): void {
  if (readers) throw new Error("Model files are in use. Wait for transcription or video analysis to finish, then retry.");
}

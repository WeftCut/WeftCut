// A file the OS asked WeftCut to open (ADR 0181): main keeps it until the
// window takes it, and tells the window when one arrives.

/** Sent when a request waits. It carries no path: the window takes it
 *  (`fileOpen:take`), so a request is handled once however many pings arrive. */
export const FILE_OPEN_REQUEST_EVENT = 'file-open-request'

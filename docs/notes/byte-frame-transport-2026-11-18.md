# Byte frames from main to a renderer: what each hop costs

Probe, 2026-11-18. Question: which channel should carry decoded byte frames
(12–25 MB each) from the main process to their consumer? **Answer:**
`webContents.send` from main, and a `MessagePort` held by the preload for the
last hop. A frame that crosses `contextBridge` is copied on the page's main
thread; a frame posted on a `MessagePortMain` costs main 1.6–2.3× a
`webContents.send` of the same bytes.

The read-completion question for shared-texture slots, measured the same day,
is in [`slot-read-completion-2026-11-18`](slot-read-completion-2026-11-18.md).

## Probe and environment

- Windows 11, i5-13400, RTX 3050, 60 Hz; macOS, M1, 8 GB. Electron 44.11 /
  Chromium 152, `contextIsolation` on as in the product. The app ran from an
  interactive session so the renderer had a real GPU.
- A bench build, never merged, with a decode-free "flood" producer in main
  (frames of a fixed size at a fixed rate) and a switch per transport arm.
  8 s windows, each cell twice in opposite order.
- busy = the page's event-loop lag as a share of the window; an idle page
  reads 8–13 %. send = the sender's time per frame, p50.

## The channel for byte frames (flood, no decode)

Arms: (a) `webContents.send` → preload → `contextBridge` callback, every open
transport listening; (a′) the same with one listener per stream; (b)
`MessagePortMain` → page; (c) `MessagePortMain` → a worker that transfers the
buffer to the page; (d) the producer in a utility process → that worker.

Windows, 12.4 MB frames (4K NV12). Timer granularity held every sender to
about 21 fps per stream.

| Arm | busy × 1 | × 2 | × 3 | send |
|---|---|---|---|---|
| (a) | 30 % | 83–88 % | collapses: 10–11 fps, seconds of backlog | 5.0–6.0 ms |
| (a′) | 30 % | 54–59 % | 85–91 % | 4.9–5.6 ms |
| (b) | 22 % | 38–45 % | 54–61 % | 8.4–10.5 ms |
| (c) | 8 % | 10 % | 12–13 % | 8.4–9.8 ms |
| (d) | 8 % | 10 % | 11–12 % | 8.4–9.0 ms, off main |

macOS, 30 fps per stream.

| Arm | 12.4 MB × 1 | × 2 | × 3 | 24.9 MB × 2 | send (12.4 / 24.9 MB) |
|---|---|---|---|---|---|
| (a) | 26–27 % | 40–42 % | 66–78 % | 74–82 % | 1.2–2.0 / 2.3–2.4 ms |
| (a′) | 26–27 % | 24–28 % | 29–34 % | 49–55 % | 1.2–1.9 / 2.2–2.4 ms |
| (b) | 21 % | 19 % | 19–23 % | 30–37 % | 2.5–4.6 / 4.9–5.7 ms |
| (c) | 12 % | 12 % | 13 % | 13 % | 2.7–4.5 / 5.3–5.7 ms |
| (d) | 12 % | 12 % | 11–12 % | 12 % | 3.1–5.5 / 5.8–5.9 ms, off main |

Reading: the `contextBridge` copy is the page's cost ((a′) against (b)); the
deserialization that remains leaves the page only with a worker ((c)); a port
send is the dearer send for main on both systems.

## The port send on main decides it

A 4K ProRes → H.264 export through native decode, 420 frames, steady-state
runs, builds alternating:

| Session served by | Windows | macOS |
|---|---|---|
| `webContents.send` → preload → bridge → page → Worker (before) | 14.6–15.8 s | 12.8 s |
| `MessagePortMain` → Worker | 16.2–16.5 s | within noise |
| `webContents.send` → port held by the preload → Worker | 14.6–15.1 s | 12.4 s |

Main sits on the export's critical path twice (decode in, encode out), so the
dearer send costs 10 % on Windows. With the preload holding the port, main
sends as before and the frame's buffer is transferred onward: no bridge copy,
no page code touching it.

The same transport for preview, 4K H.264, 20 s windows, builds alternating
three times:

| | before | after |
|---|---|---|
| Windows, software, 2 tracks: presented fps | 16.9–17.2 | 58.7–59.1 |
| Windows, software, 2 tracks: decode fps per clip (30 fps material) | 20.9–21.2 | 28.5–28.8 |
| Windows, software, 1 track: presented fps | 53.3–53.5 | 60.0 |
| macOS, 1 track: renderer CPU | 8.8–9.7 % | 6.5–6.8 % |
| macOS, 2 tracks: renderer CPU | 12.4–14.6 % | 10.7–10.8 % |
| macOS: main CPU, 1 / 2 tracks | 12.4–12.6 / 24.1–27.2 % | 12.2–12.3 / 24.1–27.2 % |

## Not measured

- Arm (c) or (d) with real decode: a worker between the preload and the page,
  or the producer outside main. Both keep the page at its floor in the flood;
  what they cost end to end is open.
- Linux.

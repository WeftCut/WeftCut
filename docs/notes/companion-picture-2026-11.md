# Companion picture: what the preview mirror costs, and where the page works

Prototype, 2026-11-08 to 2026-11-15. Question: can a page beside an agent's
chat show the editor's preview without costing the editor's own preview, and
in which host browsers does it load? **With a hardware encoder it costs
nothing visible; with a software encoder on a small machine it costs about 10
CPU points; switched off it costs nothing measurable.** The design that came
of it is ADR 0168; the wire is `docs/mcp.md` § Companion page.

## Probe and environment

- The page was served from the MCP loopback listener. The editor captured its
  preview canvas at 15 fps, encoded it with WebCodecs (H.264 Annex B
  prefer-hardware, else VP8), at most 960 px wide, a keyframe every 2 s, 2 fps
  while paused; the page decoded the stream with WebCodecs onto a canvas.
- Each run: 10 s of playback, app CPU (one core = 100), requestAnimationFrame
  frames and frame-interval percentiles in the editor. Runs alternate between
  no page, page with the mirror on, and page with the mirror off.
- Linux: a 2-core box with no WebGL2 (Pixi's canvas renderer), software VP8,
  a full-length text layer as content. Windows: i5-13400, RTX 3050, hardware
  H.264. macOS: an M1 with 8 GB, headless Chrome as the page's browser.

## Results

| Linux, 2 cores, VP8 software | app CPU % | rAF frames | p95 ms | p99 ms |
|---|---|---|---|---|
| no page | 99 | 470 | 50 | 83 |
| mirror on | 108 | 366 | 67 | 117 |
| page open, mirror off | 98 | 476 | 50 | 83 |
| mirror on | 110 | 344 | 67 | 133 |
| mirror off | 97 | 457 | 50 | 83 |

| Windows, hardware H.264 | app CPU % | rAF frames | p95 ms | p99 ms |
|---|---|---|---|---|
| no page | 39 | 601 | 16.9 | 17.0 |
| mirror on | 53 | 601 | 16.8 | 17.1 |
| page open, mirror off | 43 | 601 | 16.9 | 17.0 |
| mirror on | 48 | 601 | 16.8 | 17.3 |
| mirror off | 47 | 601 | 16.8 | 17.3 |

- Windows: encode p50 2.8 ms, p99 5 ms at 820×460; the page decoded 15 of
  15 fps, 2.1 Mbit/s, 4 ms capture to page at p50; first frame 198 ms after
  the button. The CPU difference is the size of run-to-run noise.
- Linux: encode p50 about 30 ms at 744×418; the page decoded 12–13 of 15 fps,
  42–103 ms behind at p50; first frame 330–480 ms after the button.
- macOS: hardware H.264 at 960×540, 15 fps, 7 ms behind at p50.
- Paused: about 2 frames a second reach the page on both.
- A 816×459 canvas made the Windows hardware H.264 encoder answer every frame
  with `OperationError: Encoding error`; software H.264 and VP8 took the same
  frames, and 814×458 worked everywhere. Hence the even-size trim and the
  hand-over to the next encoder.

## Window states

| Editor window, mirror on, playing | Linux (X11) | Windows |
|---|---|---|
| visible | 14 fps | 15 fps |
| covered by another window | — | 15 fps |
| hidden, throttling off | 14 fps | 15 fps |
| hidden, throttling kept | 0 fps | — |
| minimized | 14 fps (no occlusion on this X11 setup) | 1 fps |

## Hosts

- Works: a plain Chromium tab; a frame with DeepSeek Harness's sandbox
  string; a frame with `sandbox="allow-scripts"` only (opaque origin, through
  the `Origin: null` allowance); DeepSeek Harness's sidebar browser.
- ChatGPT desktop's side panel: a fetch to loopback fails (`Failed to fetch`
  in a few ms) although the host lists the address among the view's connect
  domains; the view is kept by its `ui://` address until that changes.
  WebRTC signaled over tool calls, with only the 127.0.0.1 candidate,
  connected in 167 ms and carried H.264 at 15 fps.
- On macOS, WebRTC over a LAN address waited on the firewall's prompt until a
  person allowed it; the loopback-only candidate did not.

## Not measured

A packaged app, ChatGPT desktop on macOS, the editor minimized or hidden
while ChatGPT's panel shows the picture, a machine with no network interface.

# Remote Wayland input

The shared desktop uses Weston **16.0.1**, NeatVNC **1.0.3** and AML **1.0.0**.
`server/build-weston-vnc.sh` pins the source archives/commits and applies the
matching patch. Set `WEFTCUT_WESTON_PATCH` to this directory's absolute
`weston-16.0.1-shared-vnc-seat.patch` path. Build inside the editor image, not
on the host driver installation. Required build dependencies include the
Weston GL/VNC dependencies, Meson, Ninja, Git, patch, hwdata and Wayland 1.23+.
Wayland protocols 1.46 are installed into the isolated prefix.

The supervisor opts into `WEFTCUT_VNC_SHARED_SEAT=1`: create one input seat
before Electron starts, keep it across client reconnects and release held keys
and buttons on disconnection/input-owner changes. The virtual output stays on
across reconnects; it is not a physical monitor. Without this opt-in the
upstream multi-seat behavior remains unchanged. This is not an authentication
bypass: existing PAM credentials and gateway authentication still apply.

In a remote Wayland session the editor's minimize button hides and suspends
the authenticated viewer, keeping the native surface mapped. The browser dock
restores the viewer without changing the project or native rendering. Native xdg-shell
minimization cannot reliably be undone by a client without a desktop panel.
Closing the editor leaves the supervisor waiting for an explicit restart;
crashes are not automatically retried in a loop. Running jobs still use the
native safe restart gate. Project media and export settings are unchanged.

The 14.0.2 patch is retained as a version-specific fallback reference only;
it must not be applied to 16.x. No new X11 desktop is started.

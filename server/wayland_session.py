"""Own the isolated compositor, restarting it only AFTER a saved editor exit.
Gateway, PulseAudio and websockify live outside this supervisor and stay up.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from display_settings import read_mode, write_mode
from gpu_launch import run_editor


class WaylandSession:
    def __init__(self):
        self.root = Path(os.environ.get('WEFTCUT_DATA', '/data'))
        self.run = Path(os.environ.get('XDG_RUNTIME_DIR', '/data/run'))
        self.socket = self.run / os.environ.get('WAYLAND_DISPLAY', 'wayland-qa')
        self.process = None
        self.mode = None

    def stop(self):
        if self.process and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.process = None

    def prepare(self):
        mode = read_mode(self.root / 'desktop-display.json')
        if self.mode == mode and self.process and self.process.poll() is None:
            return
        self.stop()
        print('WAYLAND_MODE requested=' + mode, flush=True)
        self.socket.unlink(missing_ok=True)
        self.socket.with_name(self.socket.name + '.lock').unlink(missing_ok=True)
        width, height = mode.split('x')
        config = self.run / 'weston-managed.ini'
        config.write_text(f'[shell]\npanel-position=none\n\n[output]\nname=vnc\nmode={mode}\nresizeable=false\n')
        compositor_env = dict(os.environ, WEFTCUT_VNC_SHARED_SEAT='1')
        weston = os.environ.get('WEFTCUT_WESTON_BINARY', '/opt/weston16-vnc/bin/weston')
        if not Path(weston).is_file():
            raise RuntimeError('The pinned Weston compositor is not installed: ' + weston)
        compositor_env['LD_LIBRARY_PATH'] = '/opt/weston16-vnc/lib/x86_64-linux-gnu:' + os.environ.get('LD_LIBRARY_PATH', '')
        self.process = subprocess.Popen([weston, '--config=' + str(config), '--backend=vnc', '--renderer=gl',
            '--socket=' + self.socket.name, '--address=127.0.0.1', '--port=5901', '--width=' + width,
            '--height=' + height, '--disable-transport-layer-security', '--idle-time=0',
            '--log=' + str(self.root / 'weston.log')], start_new_session=True, env=compositor_env)
        for _ in range(100):
            if self.process.poll() is not None:
                raise RuntimeError('Wayland compositor failed to start')
            if self.socket.exists():
                self.mode = mode
                write_mode(self.run / 'desktop-display-active.json', mode)
                return
            time.sleep(0.1)
        raise RuntimeError('Wayland compositor startup timed out')


def main():
    session = WaylandSession()
    args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-frame-rate-limit', '--disable-gpu-vsync',
        '--disable-renderer-backgrounding', '--window-size=1920,1080', '--ozone-platform=wayland',
        '--use-gl=angle', '--use-angle=gl']
    if os.environ.get('WEFTCUT_QA_DEBUG') == '1':
        args += ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1']
    try:
        return run_editor(args, before_start=session.prepare, keep_alive=True)
    finally:
        if session.process:
            print('WAYLAND_EXIT code=' + str(session.process.poll()), flush=True)
        session.stop()


if __name__ == '__main__':
    raise SystemExit(main())

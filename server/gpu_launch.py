"""Select hardware rendering only when the container has an assigned NVIDIA GPU."""
import os
import subprocess
import sys
import json
import signal
from pathlib import Path


def launch_args(mode, available):
    if mode not in ('auto', 'nvidia', 'software'):
        raise ValueError('WEFTCUT_RENDERER must be auto, nvidia, or software')
    if mode == 'nvidia' and not available:
        raise RuntimeError('NVIDIA rendering requested but no assigned NVIDIA GPU is available')
    hardware = mode == 'nvidia' or mode == 'auto' and available
    args = ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080', '--use-gl=angle']
    if hardware:
        args += ['--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
                 '--disable-vulkan-surface', '--enable-unsafe-webgpu']
    else:
        args += ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    return hardware, args


def nvidia_available():
    try:
        return subprocess.run(['nvidia-smi', '-L'], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def consume_restart_intent(path, pid):
    try:
        value = json.loads(path.read_text())
        return isinstance(value, dict) and value.get('pid') == pid
    except (OSError, ValueError):
        return False
    finally:
        path.unlink(missing_ok=True)


def run_editor(args):
    """Keep VNC/gateway alive across an explicitly saved, graceful app restart."""
    intent = Path(os.environ.get('XDG_RUNTIME_DIR', '/data/run')) / 'editor-restart.json'
    intent.unlink(missing_ok=True)  # A stale request never restarts a future PID.
    stopping = False
    child = None

    def stop(signum, _frame):
        nonlocal stopping
        stopping = True
        if child is not None and child.poll() is None:
            child.send_signal(signum)

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, stop)
    while not stopping:
        child = subprocess.Popen(['/opt/WeftCut/WeftCut', *args])
        code = child.wait()
        restart = consume_restart_intent(intent, child.pid)
        if stopping or code != 0 or not restart:
            return code
        print('EDITOR_RESTART graceful=1 project_resume=1', flush=True)
    return 0


if __name__ == '__main__':
    try:
        hardware, args = launch_args(os.environ.get('WEFTCUT_RENDERER', 'auto'), nvidia_available())
        if hardware:
            os.environ.pop('LIBGL_ALWAYS_SOFTWARE', None)
            # Minimal hosts sometimes omit the driver ICD manifest while the
            # container toolkit correctly supplies the NVIDIA driver libraries.
            # Point the loader at those injected libraries, never SwiftShader.
            if not os.environ.get('VK_DRIVER_FILES') and not os.environ.get('VK_ICD_FILENAMES'):
                os.environ['VK_ICD_FILENAMES'] = os.path.join(os.path.dirname(__file__), 'nvidia_icd.json')
        else:
            os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
        print('EDITOR_RENDERER requested=' + os.environ.get('WEFTCUT_RENDERER', 'auto') +
              ' selected=' + ('nvidia-vulkan' if hardware else 'swiftshader'), flush=True)
        sys.exit(run_editor(args))
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

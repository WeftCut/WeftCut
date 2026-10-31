"""Only explicit, bounded remote-desktop modes; never project/export sizes."""
import json
from pathlib import Path

MODES = ('1920x1080', '2560x1440', '3840x2160')
DEFAULT = MODES[0]


def read_mode(path):
    try:
        mode = json.loads(Path(path).read_text()).get('resolution')
        return mode if mode in MODES else DEFAULT
    except (OSError, ValueError, AttributeError):
        return DEFAULT


def write_mode(path, mode):
    if mode not in MODES:
        raise ValueError('Unsupported desktop resolution')
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'resolution': mode}))
    temporary.chmod(0o600)
    temporary.replace(path)

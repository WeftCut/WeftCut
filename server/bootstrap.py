"""First-run defaults only; never overwrite an existing editor's preferences."""
import json
import os
from pathlib import Path


def seed_settings(root):
    folder = Path(root) / 'settings' / 'WeftCut'
    folder.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(folder / 'app_settings.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, 'w') as stream:
        json.dump({'language': 'ru-RU', 'display_mode': 'AllTracks', 'auto_install_updates_on_quit': False,
                   'resource_policy': {'version': 1, 'memory_mib': 6144, 'processing': 'balanced',
                                       'disk_cache_mib': 2048, 'background_playback': False}}, stream)
    return True


if __name__ == '__main__':
    seed_settings(os.environ.get('WEFTCUT_DATA', '/data'))

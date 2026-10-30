"""Grant the desktop account only the groups of assigned DRM render nodes.

runuser initializes supplementary groups from /etc/group; Docker group_add
alone is lost when a root entrypoint switches to the desktop user.
"""
import grp
import os
from pathlib import Path
import re
import stat
import subprocess


def render_gids(folder=Path('/dev/dri')):
    gids = set()
    for node in folder.glob('renderD*'):
        if not re.fullmatch(r'renderD\d+', node.name):
            continue
        info = node.lstat()  # Ignore links and non-device lookalikes.
        if stat.S_ISCHR(info.st_mode) and info.st_gid != 0:
            gids.add(info.st_gid)
    return sorted(gids)


def grant_render_access(user='editor'):
    if os.geteuid() != 0:
        raise RuntimeError('DRM group setup must run before dropping root privileges')
    groups = []
    for gid in render_gids():
        try:
            name = grp.getgrgid(gid).gr_name
        except KeyError:
            name = f'weftcut-drm-{gid}'
            subprocess.run(['groupadd', '--gid', str(gid), name], check=True)
        groups.append(name)
    if groups:
        subprocess.run(['usermod', '--append', '--groups', ','.join(groups), user], check=True)
    return groups


if __name__ == '__main__':
    groups = grant_render_access()
    print('DRM desktop groups: ' + (','.join(groups) or 'no assigned render nodes'), flush=True)

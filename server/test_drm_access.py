import stat
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from drm_access import render_gids, grant_render_access


class DrmAccessTests(unittest.TestCase):
    def test_discovers_actual_device_groups_without_fixed_gid_or_symlinks(self):
        def node(name, kind, gid):
            return SimpleNamespace(name=name, lstat=lambda: SimpleNamespace(st_mode=kind, st_gid=gid))
        folder = Mock()
        folder.glob.return_value = [node('renderD128', stat.S_IFCHR, 992), node('renderD129', stat.S_IFCHR, 993),
            node('renderD130', stat.S_IFCHR, 993), node('renderD131', stat.S_IFLNK, 994),
            node('renderD132', stat.S_IFREG, 995), node('renderD133', stat.S_IFCHR, 0)]
        self.assertEqual(render_gids(folder), [992, 993])

    def test_creates_missing_group_and_appends_instead_of_replacing_memberships(self):
        with patch('drm_access.os.geteuid', return_value=0), patch('drm_access.render_gids', return_value=[993]), patch('drm_access.grp.getgrgid', side_effect=KeyError), patch('drm_access.subprocess.run') as run:
            self.assertEqual(grant_render_access(), ['weftcut-drm-993'])
            self.assertEqual(run.call_args_list[0].args[0], ['groupadd', '--gid', '993', 'weftcut-drm-993'])
            self.assertEqual(run.call_args_list[1].args[0], ['usermod', '--append', '--groups', 'weftcut-drm-993', 'editor'])

    def test_existing_group_is_reused(self):
        with patch('drm_access.os.geteuid', return_value=0), patch('drm_access.render_gids', return_value=[1200]), patch('drm_access.grp.getgrgid', return_value=SimpleNamespace(gr_name='render')), patch('drm_access.subprocess.run') as run:
            grant_render_access()
            run.assert_called_once_with(['usermod', '--append', '--groups', 'render', 'editor'], check=True)

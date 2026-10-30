import tempfile
import unittest
from pathlib import Path
from display_settings import MODES, read_mode, write_mode


class DisplayTests(unittest.TestCase):
    def test_modes_are_bounded_and_persisted(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'display.json'
            self.assertEqual(read_mode(path), '1920x1080')
            for mode in MODES:
                write_mode(path, mode)
                self.assertEqual(read_mode(path), mode)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                write_mode(path, '99999x99999')
            self.assertEqual(read_mode(path), MODES[-1])

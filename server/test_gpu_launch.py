import unittest
import json
import tempfile
from pathlib import Path
from gpu_launch import launch_args, consume_restart_intent
from gpu_launch import run_editor
from unittest.mock import patch, Mock


class LaunchTests(unittest.TestCase):
    def test_managed_close_waits_for_explicit_start_then_relaunches(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Mock(pid=123), Mock(pid=456)
            first.wait.return_value = second.wait.return_value = 0
            with patch.dict('os.environ', {'XDG_RUNTIME_DIR': directory}), patch('gpu_launch.signal.signal'), patch('gpu_launch.subprocess.Popen', side_effect=[first, second]) as launch, patch('gpu_launch.wait_for_restart', side_effect=[True, False]) as waiting:
                self.assertEqual(run_editor([], keep_alive=True), 0)
            self.assertEqual(launch.call_count, 2)
            self.assertEqual(waiting.call_count, 2)
            runtime = json.loads((Path(directory) / 'editor-runtime.json').read_text())
            self.assertEqual(runtime['state'], 'stopped')
            self.assertIsInstance(runtime['supervisor_pid'], int)

    def test_saved_restart_relaunches_editor_and_updates_runtime_pid(self):
        with tempfile.TemporaryDirectory() as directory:
            intent = Path(directory) / 'editor-restart.json'
            first, second = Mock(pid=123), Mock(pid=456)
            def saved_exit():
                intent.write_text('{"pid":123}')
                return 0
            first.wait.side_effect = saved_exit
            second.wait.return_value = 0
            prepare = Mock()
            with patch.dict('os.environ', {'XDG_RUNTIME_DIR': directory}), patch('gpu_launch.signal.signal'), patch('gpu_launch.subprocess.Popen', side_effect=[first, second]) as launch:
                self.assertEqual(run_editor(['--synthetic'], before_start=prepare), 0)
            self.assertEqual(launch.call_count, 2)
            self.assertEqual(prepare.call_count, 2)
            self.assertEqual(json.loads((Path(directory) / 'editor-runtime.json').read_text()), {'pid': 456, 'state': 'stopped'})

    def test_restart_requires_an_intent_for_the_exact_exited_editor_pid(self):
        with tempfile.TemporaryDirectory() as directory:
            intent = Path(directory) / 'editor-restart.json'
            self.assertFalse(consume_restart_intent(intent, 123))
            for body, expected in (('invalid', False), ('{"pid":456}', False), ('{"pid":123}', True)):
                intent.write_text(body)
                self.assertEqual(consume_restart_intent(intent, 123), expected)
                self.assertFalse(intent.exists())

    def test_cpu_fallback(self):
        hardware, args = launch_args('auto', False)
        self.assertFalse(hardware)
        self.assertIn('--use-angle=swiftshader', args)

    def test_assigned_gpu_uses_vulkan_not_swiftshader(self):
        for mode in ('auto', 'nvidia'):
            hardware, args = launch_args(mode, True)
            self.assertTrue(hardware)
            self.assertIn('--use-angle=vulkan', args)
            self.assertFalse(any('swiftshader' in arg for arg in args))

    def test_explicit_gpu_must_not_silently_fallback(self):
        with self.assertRaises(RuntimeError):
            launch_args('nvidia', False)
        with self.assertRaises(ValueError):
            launch_args('arbitrary-flags', True)

    def test_explicit_software(self):
        self.assertFalse(launch_args('software', True)[0])

    def test_hardware_icd_does_not_use_bundled_software_driver(self):
        manifest = json.loads(Path(__file__).with_name('nvidia_icd.json').read_text())
        self.assertEqual(manifest['ICD']['library_path'], 'libGLX_nvidia.so.0')

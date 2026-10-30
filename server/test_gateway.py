import tempfile
import unittest
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase
from gateway import cookie_value, create_app, load_key, media_path, valid_cookie, load_vnc_credentials, gateway_tls_context, vnc_credentials
from bootstrap import seed_settings

KEY = 'synthetic-test-key-' + 'a' * 32


class ClosedEditorTests(unittest.IsolatedAsyncioTestCase):
    async def test_closed_editor_queues_start_for_live_managed_supervisor(self):
        import json
        from unittest.mock import patch
        from gateway import restart_native_editor
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'run').mkdir()
            (root / 'run/editor-runtime.json').write_text(json.dumps({'pid': 123, 'state': 'stopped', 'supervisor_pid': 456}))
            with patch.object(Path, 'read_bytes', return_value=b'python3\0/opt/editor/server/wayland_session.py\0'):
                status, result = await restart_native_editor({'managed_wayland': True, 'files_root': root})
            self.assertEqual(status, 202)
            self.assertTrue(result['previously_closed'])
            self.assertEqual(json.loads((root / 'run/editor-restart.json').read_text()), {'pid': 123})

    async def test_closed_editor_does_not_signal_unrelated_process(self):
        import json
        from unittest.mock import patch
        from gateway import restart_native_editor
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'run').mkdir()
            (root / 'run/editor-runtime.json').write_text(json.dumps({'pid': 123, 'state': 'stopped', 'supervisor_pid': 456}))
            with patch.object(Path, 'read_bytes', return_value=b'python3\0/unrelated.py\0'), patch('gateway.native_auth', side_effect=OSError()):
                status, _ = await restart_native_editor({'managed_wayland': True, 'files_root': root})
            self.assertEqual(status, 503)
            self.assertFalse((root / 'run/editor-restart.json').exists())


class StorageTests(unittest.TestCase):
    def test_tls_requires_both_paths(self):
        from unittest.mock import patch
        with patch.dict('os.environ', {}, clear=True):
            self.assertIsNone(gateway_tls_context())
            with self.assertRaises(ValueError):
                gateway_tls_context(cert='/missing/cert')

    def test_desktop_credentials_reject_public_files_and_links(self):
        import json
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'credentials.json'
            credentials = {'username': 'desktop', 'password': 'synthetic-password-long'}
            path.write_text(json.dumps(credentials))
            path.chmod(0o600)
            self.assertEqual(load_vnc_credentials(path), credentials)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                load_vnc_credentials(path)
            link = Path(name) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                load_vnc_credentials(link)
            path.chmod(0o600)
            path.write_text(json.dumps({'username': 'desktop', 'password': 'short'}))
            with self.assertRaises(ValueError):
                load_vnc_credentials(path)
    def test_bootstrap_does_not_replace_preferences(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            self.assertTrue(seed_settings(root))
            path = root / 'settings' / 'WeftCut' / 'app_settings.json'
            path.write_text('{"language":"en-US"}')
            self.assertFalse(seed_settings(root))
            self.assertEqual(path.read_text(), '{"language":"en-US"}')
    def test_persistent_private_key(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            key = load_key(root)
            self.assertEqual(key, load_key(root))
            self.assertEqual((root / 'access-key').stat().st_mode & 0o777, 0o600)

    def test_cookie_signature_and_expiry(self):
        value = cookie_value(KEY, 100)
        self.assertTrue(valid_cookie(KEY, value, 50))
        self.assertFalse(valid_cookie(KEY, value, 101))
        self.assertFalse(valid_cookie(KEY + 'x', value, 50))
        self.assertFalse(valid_cookie(KEY, 'broken', 50))

    def test_upload_path_confinement(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            for filename in ('../secret', '/etc/passwd', '.hidden', 'a/b', 'a\\b', ''):
                with self.assertRaises(web.HTTPBadRequest):
                    media_path(filename, root)
            self.assertEqual(media_path('кадр 1.png', root), root / 'media' / 'кадр 1.png')
            (root / 'media').mkdir()
            (root / 'media' / 'link').symlink_to('/etc/passwd')
            with self.assertRaises(web.HTTPBadRequest):
                media_path('link', root)


class AuthTests(AioHTTPTestCase):
    async def test_display_is_protected_and_rolls_back_when_editor_is_busy(self):
        from display_settings import read_mode, write_mode
        headers = {'Authorization': 'Bearer ' + KEY}
        self.assertEqual((await self.client.get('/api/editor/runtime')).status, 401)
        self.assertEqual((await self.client.post('/api/editor/display', json={})).status, 401)
        self.app['managed_wayland'] = True
        async def busy(_app):
            return 409, {'error': 'editor_busy'}
        self.app['restart_editor'] = busy
        with tempfile.TemporaryDirectory() as name:
            self.app['files_root'] = Path(name)
            path = Path(name) / 'desktop-display.json'
            write_mode(path, '1920x1080')
            response = await self.client.post('/api/editor/display', headers=headers, json={'confirm': True, 'resolution': '2560x1440'})
            self.assertEqual(response.status, 409)
            self.assertEqual(read_mode(path), '1920x1080')
            response = await self.client.post('/api/editor/display', headers=headers, json={'confirm': True, 'resolution': '99999x99999'})
            self.assertEqual(response.status, 400)
            async def accepted(_app):
                return 202, {'status': 'restarting'}
            self.app['restart_editor'] = accepted
            response = await self.client.post('/api/editor/display', headers=headers, json={'confirm': True, 'resolution': '2560x1440'})
            self.assertEqual(response.status, 202)
            self.assertEqual(read_mode(path), '2560x1440')

    async def get_application(self):
        web_root = Path(__file__).parent.parent / 'web'
        return create_app(KEY, web_root=web_root, novnc_root=web_root)

    async def test_mcp_upload_audio_and_vnc_are_protected(self):
        for path in ('/mcp', '/api/audio', '/websockify', '/api/vnc-credentials', '/api/media', '/api/gpu', '/api/files', '/api/files/events', '/api/files/unknown/download'):
            response = await self.client.get(path)
            self.assertEqual(response.status, 401, path)
        response = await self.client.put('/api/media/clip.mp4', data=b'not-media')
        self.assertEqual(response.status, 401)
        response = await self.client.post('/api/editor/restart', json={'confirm': True})
        self.assertEqual(response.status, 401)

    async def test_desktop_credentials_are_opt_in_and_require_tls(self):
        headers = {'Authorization': 'Bearer ' + KEY}
        response = await self.client.get('/api/vnc-credentials', headers=headers)
        self.assertEqual(response.status, 404)
        self.app['vnc_credentials_file'] = '/not-read-over-http'
        response = await self.client.get('/api/vnc-credentials', headers=headers)
        self.assertEqual(response.status, 426)
        response = await self.client.get('/api/vnc-credentials', headers={**headers, 'X-Forwarded-Proto': 'https'})
        self.assertEqual(response.status, 426)

    async def test_tls_desktop_credentials_response_is_private_and_contains_no_api_key(self):
        import json
        from aiohttp.test_utils import make_mocked_request
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'credentials.json'
            credentials = {'username': 'desktop', 'password': 'synthetic-desktop-password'}
            path.write_text(json.dumps(credentials))
            path.chmod(0o600)
            self.app['vnc_credentials_file'] = path
            # TLS is a transport property; an absolute HTTPS target alone does
            # not make a mocked connection secure on newer aiohttp versions.
            import ssl
            request = make_mocked_request('GET', '/api/vnc-credentials', app=self.app,
                                          sslcontext=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER))
            response = await vnc_credentials(request)
            self.assertEqual(json.loads(response.body), credentials)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertNotIn(KEY, response.text)

    async def test_editor_restart_requires_confirmation_and_preserves_native_busy_refusal(self):
        calls = []
        async def refused(_app):
            calls.append(True)
            return 409, {'error': 'editor_busy'}
        self.app['restart_editor'] = refused
        headers = {'Authorization': 'Bearer ' + KEY}
        response = await self.client.post('/api/editor/restart', headers=headers, json={})
        self.assertEqual(response.status, 400)
        self.assertEqual(calls, [])
        response = await self.client.post('/api/editor/restart', headers=headers, json={'confirm': True})
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())['error'], 'editor_busy')
        self.assertEqual(calls, [True])

    async def test_browser_restart_rejects_cross_origin_and_missing_origin(self):
        response = await self.client.post('/api/login', json={'key': KEY})
        self.client.session.cookie_jar.update_cookies({'weftcut_session': response.cookies['weftcut_session'].value})
        for headers in ({}, {'Origin': 'https://evil.invalid'}):
            response = await self.client.post('/api/editor/restart', headers=headers, json={'confirm': True})
            self.assertEqual(response.status, 403)

    async def test_bearer_and_cookie(self):
        response = await self.client.get('/api/media', headers={'Authorization': 'Bearer ' + KEY})
        self.assertEqual(response.status, 200)
        response = await self.client.post('/api/login', json={'key': KEY})
        self.assertEqual(response.status, 200)
        cookie = response.cookies['weftcut_session']
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Strict')
        self.client.session.cookie_jar.update_cookies({'weftcut_session': cookie.value})
        response = await self.client.get('/api/media', headers={'Origin': 'https://evil.invalid'})
        self.assertEqual(response.status, 403)

    async def test_bad_login_throttles(self):
        for _ in range(10):
            response = await self.client.post('/api/login', json={'key': 'incorrect'})
            self.assertEqual(response.status, 401)
        response = await self.client.post('/api/login', json={'key': KEY})
        self.assertEqual(response.status, 429)

    async def test_browser_password_does_not_weaken_api_key(self):
        self.app['browser_password'] = '1234'
        response = await self.client.post('/api/login', json={'key': '1234'})
        self.assertEqual(response.status, 200)
        self.client.session.cookie_jar.clear()
        response = await self.client.get('/api/media', headers={'Authorization': 'Bearer 1234'})
        self.assertEqual(response.status, 401)
        response = await self.client.get('/api/media', headers={'Authorization': 'Bearer ' + KEY})
        self.assertEqual(response.status, 200)


class ExportFileTests(AioHTTPTestCase):
    async def get_application(self):
        self.storage = tempfile.TemporaryDirectory()
        self.root = Path(self.storage.name)
        self.output = self.root / 'projects' / 'demo' / 'output'
        self.output.mkdir(parents=True)
        self.file = self.output / 'Тест фильма.mp4'
        self.file.write_bytes(b'0123456789')
        web_root = Path(__file__).parent.parent / 'web'
        return create_app(KEY, web_root=web_root, novnc_root=web_root, data_root=self.root)

    async def tearDownAsync(self):
        await super().tearDownAsync()
        self.storage.cleanup()

    async def register(self):
        response = await self.client.post('/api/files/reveal', headers={'Authorization': 'Bearer ' + KEY}, json={'path': str(self.file)})
        self.assertEqual(response.status, 201)
        return await response.json()

    async def test_file_size_name_listing_and_streamed_download(self):
        file = await self.register()
        self.assertEqual(file['name'], self.file.name)
        self.assertEqual(file['bytes'], 10)
        headers = {'Authorization': 'Bearer ' + KEY}
        response = await self.client.get('/api/files', headers=headers)
        self.assertEqual((await response.json())['files'][0]['id'], file['id'])
        response = await self.client.get(file['download_url'], headers=headers)
        self.assertEqual(await response.read(), b'0123456789')
        self.assertTrue(response.headers['Content-Disposition'].startswith("attachment; filename*=UTF-8''"))
        response = await self.client.get(file['download_url'], headers={**headers, 'Range': 'bytes=2-5'})
        self.assertEqual(response.status, 206)
        self.assertEqual(response.headers['Content-Range'], 'bytes 2-5/10')
        self.assertEqual(await response.read(), b'2345')
        response = await self.client.head(file['download_url'], headers=headers)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Content-Length'], '10')
        self.assertEqual(await response.read(), b'')

    async def test_repeated_reveal_keeps_the_download_id_but_publishes_a_new_event(self):
        first = await self.register()
        event = self.app['last_file_reveal']['event_id']
        second = await self.register()
        self.assertEqual(first['id'], second['id'])
        self.assertNotEqual(event, self.app['last_file_reveal']['event_id'])

    async def test_download_refuses_changed_file_or_symlink_swap(self):
        file = await self.register()
        headers = {'Authorization': 'Bearer ' + KEY}
        self.file.write_bytes(b'changed file')
        response = await self.client.get(file['download_url'], headers=headers)
        self.assertEqual(response.status, 410)
        self.file.unlink()
        self.file.symlink_to('/etc/passwd')
        response = await self.client.get(file['download_url'], headers=headers)
        self.assertEqual(response.status, 404)

    async def test_reveal_rejects_secret_paths_symlinks_and_traversal(self):
        secret = self.root / 'settings' / 'secret'
        secret.parent.mkdir()
        secret.write_text('private')
        (self.output / 'linked.mp4').symlink_to(secret)
        (self.root / 'exports').symlink_to(secret.parent, target_is_directory=True)
        for file in (secret, self.output / 'linked.mp4', self.root / 'exports' / 'secret', self.output / '..' / '..' / '..' / 'settings' / 'secret', Path('/etc/passwd')):
            response = await self.client.post('/api/files/reveal', headers={'Authorization': 'Bearer ' + KEY}, json={'path': str(file)})
            self.assertIn(response.status, (403, 404), str(file))

    async def test_cookie_cannot_register_files_but_can_download_them(self):
        file = await self.register()
        response = await self.client.post('/api/login', json={'key': KEY})
        self.client.session.cookie_jar.update_cookies({'weftcut_session': response.cookies['weftcut_session'].value})
        response = await self.client.post('/api/files/reveal', headers={'Origin': str(self.client.make_url('/')).rstrip('/')}, json={'path': str(self.file)})
        self.assertEqual(response.status, 403)
        response = await self.client.get(file['download_url'])
        self.assertEqual(await response.read(), b'0123456789')

    async def test_invalid_byte_range_does_not_download_the_whole_file(self):
        file = await self.register()
        for value in ('bytes=100-200', 'bytes=bad', 'bytes=0-1,3-4'):
            response = await self.client.get(file['download_url'], headers={'Authorization': 'Bearer ' + KEY, 'Range': value})
            self.assertEqual(response.status, 416)
        response = await self.client.get(file['download_url'], headers={'Authorization': 'Bearer ' + KEY, 'Range': 'bytes=-3'})
        self.assertEqual(await response.read(), b'789')


if __name__ == '__main__':
    unittest.main()

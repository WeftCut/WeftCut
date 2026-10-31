"""Authenticated LAN gateway for a single persistent WeftCut desktop.

Electron's MCP and VNC stay on loopback. Neither native auth nor DNS-rebinding
protection is weakened: MCP requests are re-authorized at both boundaries.
"""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import time
import stat
import ssl
import re
from urllib.parse import quote

from aiohttp import ClientError, ClientSession, ClientTimeout, WSMsgType, web
from display_settings import MODES, read_mode, write_mode

ROOT = Path(os.environ.get('WEFTCUT_DATA', '/data'))
WEB = Path(os.environ.get('WEFTCUT_WEB', '/opt/editor/web'))
AUTH = ROOT / 'settings' / 'WeftCut' / 'mcp_auth.json'
MAX_UPLOAD = 4 * 1024**3
COOKIE = 'weftcut_session'


def load_key(root=ROOT):
    root.mkdir(parents=True, exist_ok=True)
    path = root / 'access-key'
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w') as stream:
            stream.write(secrets.token_urlsafe(40))
    path.chmod(0o600)
    key = path.read_text().strip()
    if len(key) < 32:
        raise ValueError('Invalid access-key; restore a valid persistent key')
    return key


def cookie_value(key, expires):
    signature = hmac.new(key.encode(), str(expires).encode(), hashlib.sha256).hexdigest()
    return f'{expires}.{signature}'


def valid_cookie(key, value, now=None):
    try:
        expiry, _ = value.split('.', 1)
        return int(expiry) > (now or time.time()) and hmac.compare_digest(value, cookie_value(key, int(expiry)))
    except (ValueError, AttributeError):
        return False


def media_path(name, root=ROOT):
    if not name or name.startswith('.') or Path(name).name != name or '\\' in name or '\x00' in name:
        raise web.HTTPBadRequest(text='Use a plain, non-hidden filename')
    path = root / 'media' / name
    if path.is_symlink():
        raise web.HTTPBadRequest(text='Symlink upload target refused')
    return path


def native_auth():
    data = json.loads(AUTH.read_text())
    if not isinstance(data.get('port'), int) or not 0 < data['port'] < 65536 or len(data.get('token', '')) < 32:
        raise ValueError('Invalid native MCP descriptor')
    return data


@web.middleware
async def gate(request, handler):
    if request.path in ('/health', '/login', '/api/login', '/login.js', '/style.css'):
        return await handler(request)
    key = request.app['key']
    bearer = hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + key)
    if not bearer and not valid_cookie(key, request.cookies.get(COOKIE)):
        if request.path == '/':
            raise web.HTTPFound('/login')
        raise web.HTTPUnauthorized(text='An editor access key is required')
    origin = request.headers.get('Origin')
    # Cookies must never authorize cross-site mutations or cross-site VNC.
    if not bearer and origin and origin != f'{request.scheme}://{request.host}':
        raise web.HTTPForbidden(text='Cross-origin request refused')
    if not bearer and request.method not in ('GET', 'HEAD') and not origin:
        raise web.HTTPForbidden(text='Use a same-origin browser or Bearer authentication')
    response = await handler(request)
    return response


async def health(request):
    try:
        auth = native_auth()
        async with request.app['http'].get(f'http://127.0.0.1:{auth["port"]}/mcp',
                headers={'Authorization': 'Bearer ' + auth['token']}, timeout=ClientTimeout(total=2)) as response:
            ready = response.status in (400, 406)
        reader, writer = await asyncio.wait_for(asyncio.open_connection('127.0.0.1', 6080), 2)
        writer.close()
        await writer.wait_closed()
        if not ready:
            raise ValueError('MCP is not ready')
        return web.json_response({'status': 'ready', 'editor': '0.5.4', 'release': os.environ.get('EDITOR_RELEASE', '0.5.4-neith.3'),
                                  'revision': os.environ.get('SOURCE_REVISION', 'development')})
    except (OSError, ValueError, ClientError, asyncio.TimeoutError):
        return web.json_response({'status': 'starting'}, status=503)


async def login(request):
    peer = request.remote or 'unknown'
    now = time.monotonic()
    attempts = request.app['attempts']
    # Bounded in-memory limiter, no credentials or failed input in logs.
    if len(attempts) > 1000:
        attempts.clear()
    last, count = attempts.get(peer, (now, 0))
    if now - last > 60:
        last, count = now, 0
    if count >= 10:
        raise web.HTTPTooManyRequests(text='Try again in one minute')
    attempts[peer] = (last, count + 1)
    data = await request.json()
    if not isinstance(data.get('key'), str) or not hmac.compare_digest(data['key'], request.app['browser_password']):
        raise web.HTTPUnauthorized(text='Invalid access key')
    attempts.pop(peer, None)
    response = web.json_response({'ok': True})
    response.set_cookie(COOKIE, cookie_value(request.app['key'], int(time.time()) + 86400),
                        httponly=True, samesite='Strict', secure=request.secure, max_age=86400)
    return response


async def mcp(request):
    try:
        auth = native_auth()
    except (OSError, ValueError):
        raise web.HTTPServiceUnavailable(text='Editor MCP is starting')
    port = auth['port']
    headers = {k: v for k, v in request.headers.items() if k.lower() in
               ('accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id')}
    headers['Authorization'] = 'Bearer ' + auth['token']
    # Host is generated for the real loopback URL, never forwarded from LAN.
    async with request.app['http'].request(request.method, f'http://127.0.0.1:{port}/mcp',
            data=request.content if request.can_read_body else None, headers=headers) as upstream:
        response = web.StreamResponse(status=upstream.status, headers={k: v for k, v in upstream.headers.items()
            if k.lower() in ('content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control', 'allow')})
        await response.prepare(request)
        try:
            async for chunk in upstream.content.iter_any():
                await response.write(chunk)
        except ConnectionResetError:
            # Closing a client's long-lived SSE stream is a normal MCP close.
            # Exit the upstream context promptly; do not leak its subscription.
            pass
        return response


async def vnc(request):
    downstream = web.WebSocketResponse(protocols=['binary'], heartbeat=25, max_msg_size=16 * 1024**2)
    await downstream.prepare(request)
    async with request.app['http'].ws_connect('http://127.0.0.1:6080/websockify', protocols=['binary'],
            max_msg_size=16 * 1024**2) as upstream:
        async def relay(source, destination):
            async for message in source:
                if message.type == WSMsgType.BINARY:
                    await destination.send_bytes(message.data)
                elif message.type == WSMsgType.TEXT:
                    await destination.send_str(message.data)
                else:
                    break
        tasks = [asyncio.create_task(relay(downstream, upstream)), asyncio.create_task(relay(upstream, downstream))]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    return downstream


def load_vnc_credentials(path):
    # The file describes the container-local desktop account, never a host
    # account or the MCP API key. Reject links, public files and unbounded input.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or not 0 < info.st_size <= 4096:
            raise ValueError('Invalid desktop credential file')
        data = json.loads(os.read(fd, 4097))
    finally:
        os.close(fd)
    if not isinstance(data, dict):
        raise ValueError('Invalid desktop credentials')
    username, password = data.get('username'), data.get('password')
    if (not isinstance(username, str) or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,63}', username)
            or not isinstance(password, str) or not 16 <= len(password) <= 256):
        raise ValueError('Invalid desktop credentials')
    return {'username': username, 'password': password}


async def vnc_credentials(request):
    path = request.app['vnc_credentials_file']
    if path is None:
        raise web.HTTPNotFound(text='Desktop credentials are not configured')
    if not request.secure:
        raise web.HTTPUpgradeRequired(text='Use HTTPS to connect to this desktop')
    try:
        credentials = load_vnc_credentials(path)
    except (OSError, ValueError):
        raise web.HTTPServiceUnavailable(text='Desktop authentication is not ready')
    return web.json_response(credentials, headers={'Cache-Control': 'no-store', 'Pragma': 'no-cache'})


def gateway_tls_context(cert=None, key=None):
    cert = cert or os.environ.get('WEFTCUT_TLS_CERT')
    key = key or os.environ.get('WEFTCUT_TLS_KEY')
    if not cert and not key:
        return None
    if not cert or not key:
        raise ValueError('Both WEFTCUT_TLS_CERT and WEFTCUT_TLS_KEY are required')
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    return context


async def audio(request):
    response = web.StreamResponse(headers={'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store'})
    await response.prepare(request)
    process = await asyncio.create_subprocess_exec('parec', '--format=float32le', '--rate=48000', '--channels=2',
        '--device=editor.monitor', '--latency-msec=40', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        while data := await process.stdout.read(16384):
            await response.write(data)
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        if process.returncode is None:
            process.terminate()
        await process.wait()
    return response


async def upload(request):
    path = media_path(request.match_info['name'])
    if path.exists():
        raise web.HTTPConflict(text='Media exists; use its existing path or another name')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / ('.upload-' + secrets.token_hex(16))
    size = 0
    digest = hashlib.sha256()
    try:
        with temporary.open('xb') as stream:
            async for chunk in request.content.iter_chunked(1024**2):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=size)
                digest.update(chunk)
                stream.write(chunk)
        expected = request.headers.get('X-Content-SHA256')
        if expected and not hmac.compare_digest(expected.lower(), digest.hexdigest()):
            raise web.HTTPBadRequest(text='Uploaded file checksum mismatch')
        # Atomic no-clobber publication, including concurrent uploads.
        try:
            os.link(temporary, path)
        except FileExistsError:
            raise web.HTTPConflict(text='Media was uploaded concurrently')
    finally:
        temporary.unlink(missing_ok=True)
    return web.json_response({'path': str(path), 'bytes': size, 'sha256': digest.hexdigest()}, status=201)


async def media_list(request):
    folder = ROOT / 'media'
    return web.json_response({'files': [{'name': p.name, 'path': str(p), 'bytes': p.stat().st_size}
        for p in sorted(folder.iterdir()) if p.is_file() and not p.is_symlink() and not p.name.startswith('.')] if folder.exists() else []})


async def lifecycle(app):
    app['http'] = ClientSession(timeout=ClientTimeout(total=None, sock_connect=10))
    yield
    await app['http'].close()


async def login_page(request):
    return web.FileResponse(WEB / 'login.html')


async def editor_page(request):
    return web.FileResponse(WEB / 'index.html')


async def response_headers(request, response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Frame-Options'] = 'DENY'
    if request.path.startswith('/novnc/') or request.path.endswith(('.js', '.mjs')):
        response.headers.setdefault('Cache-Control', 'no-cache')


async def gpu_info(request):
    try:
        return web.json_response(json.loads((ROOT / 'run' / 'gpu-info.json').read_text()))
    except (OSError, ValueError):
        return web.json_response({'status': 'starting'}, status=503)


async def restart_native_editor(app):
    # Closing the native window leaves the managed desktop alive. Ask its
    # supervisor to start again, rather than calling the now-absent MCP server.
    if app.get('managed_wayland'):
        root = app['files_root'] / 'run'
        try:
            runtime = json.loads((root / 'editor-runtime.json').read_text())
            supervisor_pid = runtime.get('supervisor_pid')
            if runtime.get('state') == 'stopped' and isinstance(supervisor_pid, int) and supervisor_pid > 1:
                argv = Path(f'/proc/{supervisor_pid}/cmdline').read_bytes().split(b'\0')
                if b'/opt/editor/server/wayland_session.py' in argv:
                    intent = root / 'editor-restart.json'
                    temporary = intent.with_suffix('.gateway.tmp')
                    temporary.write_text(json.dumps({'pid': runtime['pid']}))
                    temporary.replace(intent)
                    return 202, {'status': 'restarting', 'previously_closed': True}
        except (OSError, ValueError, KeyError, TypeError):
            pass
    try:
        auth = native_auth()
        async with app['http'].post(f'http://127.0.0.1:{auth["port"]}/mcp/editor-restart',
                headers={'Authorization': 'Bearer ' + auth['token']}, json={},
                timeout=ClientTimeout(total=30)) as response:
            return response.status, await response.json()
    except (OSError, ValueError, ClientError, asyncio.TimeoutError):
        return 503, {'error': 'editor_unavailable'}


async def editor_restart(request):
    try:
        confirmed = await request.json()
    except (ValueError, web.HTTPException):
        raise web.HTTPBadRequest(text='Explicit confirmation is required')
    if confirmed != {'confirm': True}:
        raise web.HTTPBadRequest(text='Explicit confirmation is required')
    async with request.app['editor_change_lock']:
        status, result = await request.app['restart_editor'](request.app)
    return web.json_response(result, status=status)


async def editor_runtime(request):
    root = request.app['files_root']
    try:
        runtime = json.loads((root / 'run' / 'editor-runtime.json').read_text())
    except (OSError, ValueError):
        runtime = {'pid': None, 'state': 'unknown'}
    try:
        window = json.loads((root / 'run' / 'editor-window.json').read_text())
        if window.get('pid') == runtime.get('pid'):
            runtime['window'] = {'minimized': window.get('minimized') is True, 'visible': window.get('visible') is True}
    except (OSError, ValueError, AttributeError):
        pass
    return web.json_response({**runtime, 'display_supported': request.app['managed_wayland'],
        'resolution': read_mode(root / 'run' / 'desktop-display-active.json'), 'modes': MODES},
        headers={'Cache-Control': 'no-store'})


async def editor_window(request):
    try:
        data = await request.json()
    except (ValueError, web.HTTPException):
        raise web.HTTPBadRequest(text='Invalid window action')
    if data != {'action': 'restore'}:
        raise web.HTTPBadRequest(text='Only restore is supported')
    try:
        auth = native_auth()
        async with request.app['http'].post(f'http://127.0.0.1:{auth["port"]}/mcp/editor-window',
                headers={'Authorization': 'Bearer ' + auth['token']}, json=data,
                timeout=ClientTimeout(total=5)) as response:
            return web.json_response(await response.json(), status=response.status)
    except (OSError, ValueError, ClientError, asyncio.TimeoutError):
        return web.json_response({'error': 'editor_unavailable'}, status=503)


async def editor_display(request):
    if not request.app['managed_wayland']:
        raise web.HTTPConflict(text='Managed Wayland display is unavailable')
    try:
        data = await request.json()
    except (ValueError, web.HTTPException):
        raise web.HTTPBadRequest(text='Invalid resolution request')
    if not isinstance(data, dict) or set(data) != {'resolution', 'confirm'} or data.get('confirm') is not True or data.get('resolution') not in MODES:
        raise web.HTTPBadRequest(text='Choose a supported resolution and confirm saving/restarting')
    root = request.app['files_root']
    async with request.app['editor_change_lock']:
        previous = read_mode(root / 'desktop-display.json')
        write_mode(root / 'desktop-display.json', data['resolution'])
        status, result = await request.app['restart_editor'](request.app)
        if status != 202:
            write_mode(root / 'desktop-display.json', previous)
    return web.json_response(result, status=status)


def open_export_file(value, root):
    """Walk with directory fds: no symlink (including parent swaps) can turn
    an export download into access to settings, credentials or host files."""
    if not isinstance(value, str) or '\x00' in value:
        raise web.HTTPBadRequest(text='Invalid export path')
    candidate = Path(value)
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        raise web.HTTPForbidden(text='File is outside export storage')
    parts = relative.parts
    if (not candidate.is_absolute() or any(p.startswith('.') or '\\' in p for p in parts)
            or not (len(parts) >= 2 and parts[0] == 'exports'
                    or len(parts) >= 4 and parts[0] == 'projects' and parts[2] == 'output')):
        raise web.HTTPForbidden(text='Only published export folders can be downloaded')
    directory = None
    try:
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
            os.close(fd)
            raise web.HTTPNotFound(text='No completed export file')
        return fd, info
    except OSError:
        raise web.HTTPNotFound(text='Export file is missing or unavailable')
    finally:
        if directory is not None:
            os.close(directory)


def public_export(entry):
    return {key: entry[key] for key in ('id', 'name', 'bytes', 'folder', 'download_url')}


async def file_reveal(request):
    # Browser cookies authorize downloads, never native filesystem registration.
    if not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + request.app['key']):
        raise web.HTTPForbidden(text='Native editor authorization is required')
    try:
        data = await request.json()
    except ValueError:
        raise web.HTTPBadRequest(text='Expected an export path')
    path = data.get('path') if isinstance(data, dict) else None
    fd, info = open_export_file(path, request.app['files_root'])
    os.close(fd)
    files = request.app['export_files']
    existing = next((e for e in files.values() if e['path'] == path and e['identity'] == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)), None)
    if existing is None:
        token = secrets.token_urlsafe(24)
        existing = {'id': token, 'path': path, 'name': Path(path).name, 'folder': str(Path(path).parent), 'bytes': info.st_size,
                    'identity': (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns), 'download_url': '/api/files/' + token + '/download'}
        if len(files) >= 128:
            files.pop(next(iter(files)))
        files[token] = existing
    event = {'event_id': secrets.token_hex(12), 'file': public_export(existing)}
    request.app['last_file_reveal'] = event
    for queue in request.app['file_watchers']:
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(event)
    return web.json_response(public_export(existing), status=201)


async def file_list(request):
    response = web.json_response({'files': [public_export(e) for e in reversed(list(request.app['export_files'].values()))]})
    response.headers['Cache-Control'] = 'no-store'
    return response


async def file_events(request):
    watchers = request.app['file_watchers']
    if len(watchers) >= 16:
        raise web.HTTPTooManyRequests(text='Too many file browser connections')
    queue = asyncio.Queue(maxsize=4)
    watchers.add(queue)
    if request.app['last_file_reveal'] is not None:
        queue.put_nowait(request.app['last_file_reveal'])
    response = web.StreamResponse(headers={'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'})
    try:
        await response.prepare(request)
        await response.write(b': connected\n\n')
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), 25)
                await response.write(('event: reveal\ndata: ' + json.dumps(event) + '\n\n').encode())
            except asyncio.TimeoutError:
                await response.write(b': heartbeat\n\n')
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        watchers.discard(queue)
    return response


async def file_download(request):
    entry = request.app['export_files'].get(request.match_info['id'])
    if not entry:
        raise web.HTTPNotFound(text='Reopen the exported file in the editor')
    fd, info = open_export_file(entry['path'], request.app['files_root'])
    try:
        if entry['identity'] != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
            raise web.HTTPGone(text='File changed; reopen it in the editor')
        start, stop, status_code = 0, info.st_size, 200
        headers = {'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
                   'Content-Disposition': "attachment; filename*=UTF-8''" + quote(entry['name'], safe='')}
        if 'Range' in request.headers:
            try:
                byte_range = request.http_range
                start = byte_range.start or 0
                start = max(0, info.st_size + start) if start < 0 else start
                stop = min(byte_range.stop, info.st_size) if byte_range.stop is not None else info.st_size
                if start >= stop or start >= info.st_size:
                    raise ValueError('Unsatisfiable range')
            except ValueError:
                raise web.HTTPRequestRangeNotSatisfiable(headers={'Content-Range': f'bytes */{info.st_size}'})
            status_code = 206
            headers['Content-Range'] = f'bytes {start}-{stop - 1}/{info.st_size}'
        headers['Content-Length'] = str(stop - start)
        response = web.StreamResponse(status=status_code, headers=headers)
        await response.prepare(request)
        if request.method != 'HEAD':
            os.lseek(fd, start, os.SEEK_SET)
            remaining = stop - start
            while remaining:
                chunk = await asyncio.to_thread(os.read, fd, min(1024**2, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                await response.write(chunk)
        return response
    except ConnectionResetError:
        return response
    finally:
        os.close(fd)


def create_app(key=None, web_root=WEB, novnc_root=Path('/usr/share/novnc'), browser_password=None, data_root=ROOT, vnc_credentials_file=None):
    app = web.Application(middlewares=[gate], client_max_size=50 * 1024**2)
    app['key'] = key or load_key()
    app['browser_password'] = browser_password or os.environ.get('WEFTCUT_BROWSER_PASSWORD') or app['key']
    if len(app['browser_password']) < 4:
        raise ValueError('Browser password must contain at least four characters')
    app['attempts'] = {}
    app['vnc_credentials_file'] = vnc_credentials_file or os.environ.get('WEFTCUT_VNC_CREDENTIALS_FILE')
    app['restart_editor'] = restart_native_editor
    app['editor_change_lock'] = asyncio.Lock()
    app['managed_wayland'] = os.environ.get('WEFTCUT_MANAGED_WAYLAND') == '1'
    app['files_root'] = data_root
    app['export_files'] = {}
    app['file_watchers'] = set()
    app['last_file_reveal'] = None
    app.cleanup_ctx.append(lifecycle)
    app.on_response_prepare.append(response_headers)
    app.router.add_get('/health', health)
    app.router.add_get('/login', login_page)
    app.router.add_post('/api/login', login)
    app.router.add_route('*', '/mcp', mcp)
    app.router.add_get('/api/vnc-credentials', vnc_credentials)
    app.router.add_get('/websockify', vnc)
    app.router.add_get('/api/audio', audio)
    app.router.add_get('/api/gpu', gpu_info)
    app.router.add_post('/api/editor/restart', editor_restart)
    app.router.add_get('/api/editor/runtime', editor_runtime)
    app.router.add_post('/api/editor/window', editor_window)
    app.router.add_post('/api/editor/display', editor_display)
    app.router.add_post('/api/files/reveal', file_reveal)
    app.router.add_get('/api/files/events', file_events)
    app.router.add_get('/api/files', file_list)
    app.router.add_get('/api/files/{id}/download', file_download)
    app.router.add_get('/api/media', media_list)
    app.router.add_put('/api/media/{name}', upload)
    app.router.add_get('/', editor_page)
    app.router.add_static('/novnc/', novnc_root, show_index=False)
    app.router.add_static('/', web_root, show_index=False)
    return app


if __name__ == '__main__':
    web.run_app(create_app(novnc_root=Path(os.environ.get('WEFTCUT_NOVNC_ROOT', '/usr/share/novnc'))),
                host='0.0.0.0', port=8080, access_log=None, ssl_context=gateway_tls_context())

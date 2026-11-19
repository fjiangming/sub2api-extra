#!/usr/bin/env python3
"""Stage and verify the old-domain notice; change the live config only with --apply."""

import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request


CONFIG = Path('/etc/nginx/conf.d/migrated-services.conf')
PUBLIC = Path('/var/www/epoint-domain-migration')
OLD_HOST = 'epoint2api.fjmooo.cn'
NEW_HOST = 'yunhop.cc'
PREFIX = '/__domain-migration/'
MARKER = b'class="heading-protocol">https://'
BEGIN = '# BEGIN epoint domain migration notice\n'
END = '# END epoint domain migration notice\n'
MAPS = '''map "$request_method:$http_accept" $epoint_migration_html {
    default 0;
    ~*^(GET|HEAD):.*text/html 1;
}

map $uri $epoint_migration_exempt {
    default 0;
    ~^/(api|v1|v1beta|backend-api|responses|chat|images|realtime|openai|antigravity|gemini|auth|oauth|payment|pay|payments|webhooks?|notify|callback|assets|static)(/|$) 1;
    ~^/(email-verify|reset-password)(/|$) 1;
    ~^/__domain-migration/ 1;
    ~*(callback|webhook|notify) 1;
}

map "$http_authorization:$http_upgrade" $epoint_migration_credentials {
    default 1;
    ":" 0;
}

map "$epoint_migration_html:$epoint_migration_exempt:$epoint_migration_credentials" $epoint_migration_show {
    default 0;
    "1:0:0" 1;
}
'''
GATE = '''        # Domain notice is independent of the existing maintenance switch.
        error_page 470 =200 /__domain-migration/index.html;
        if ($epoint_migration_show) { return 470; }

'''
READ_ONLY = [
    ('/api/v1/settings/public', 'GET', {}),
    ('/v1/models', 'GET', {}),
    ('/v1beta/models', 'GET', {}),
    ('/responses', 'GET', {}),
    ('/backend-api/codex/responses', 'GET', {}),
    ('/realtime', 'GET', {}),
    ('/auth/callback', 'GET', {}),
    ('/auth/linuxdo/callback', 'GET', {}),
    ('/payment/result', 'GET', {}),
    ('/reset-password', 'GET', {}),
    ('/', 'GET', {'Accept': 'application/json'}),
    ('/', 'GET', {'Authorization': 'Bearer invalid-migration-deployment-probe'}),
    ('/__migration_method_probe__', 'POST', {}),
    ('/__migration_method_probe__', 'OPTIONS', {}),
]


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stdout}{result.stderr}')
    return result.stdout + result.stderr


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data, original=None):
    temporary = path.with_name(path.name + f'.migration-{os.getpid()}.tmp')
    try:
        with temporary.open('xb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        if original:
            stat = original.stat()
            os.chmod(temporary, stat.st_mode & 0o777)
            os.chown(temporary, stat.st_uid, stat.st_gid)
        else:
            os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def validate(path=None):
    args = ['nginx', '-t'] + (['-c', str(path)] if path else [])
    output = run(*args)
    if any(word in output.lower() for word in ['conflicting server name', 'duplicate', '[warn]', '[emerg]']):
        raise RuntimeError('Nginx configuration warning: ' + output)
    return output


def config_snapshot():
    paths = {Path('/etc/nginx/nginx.conf'), Path('/etc/nginx/mime.types')}
    paths.update(Path('/etc/nginx/conf.d').glob('*.conf'))
    paths.update(Path('/etc/nginx/snippets').glob('*.conf'))
    return {str(p): sha(p.read_bytes()) for p in sorted(paths) if p.is_file()}


def runtime_snapshot():
    ids = run('docker', 'ps', '-q').split()
    containers = run('docker', 'inspect', '--format', '{{.Name}} {{.Id}} {{.State.StartedAt}}', *ids)
    return {
        'containers': sorted(containers.strip().splitlines()),
        'nginx_pid': run('systemctl', 'show', 'nginx', '-p', 'MainPID', '--value').strip(),
        'x_ui_pid': run('systemctl', 'show', 'x-ui', '-p', 'MainPID', '--value').strip(),
    }


def bundle(assets):
    names = ['index.html', 'demo.css', 'demo.js', 'lucide.min.js']
    files = {name: (assets / name).read_bytes() for name in names}
    html = files['index.html'].decode('utf-8-sig')
    for old, new in [
        ('href="demo.css"', 'href="/__domain-migration/demo.css"'),
        ('src="demo.js"', 'src="/__domain-migration/demo.js"'),
        ('src="../../node_modules/lucide/dist/umd/lucide.min.js"', 'src="/__domain-migration/lucide.min.js"'),
    ]:
        if html.count(old) != 1:
            raise RuntimeError('Unexpected demo asset reference: ' + old)
        html = html.replace(old, new)
    files['index.html'] = html.encode('utf-8')
    release = sha(b''.join(name.encode() + b'\0' + data for name, data in sorted(files.items())))[:20]
    directory = PUBLIC / release
    if PUBLIC.is_symlink() or directory.is_symlink():
        raise RuntimeError('Public deployment directory cannot be a symlink')
    if not PUBLIC.parent.exists():
        PUBLIC.parent.mkdir(mode=0o755)
        os.chmod(PUBLIC.parent, 0o755)
    PUBLIC.mkdir(mode=0o755, exist_ok=True)
    if directory.exists():
        if {p.name: p.read_bytes() for p in directory.iterdir()} != files:
            raise RuntimeError('Existing immutable release differs')
    else:
        directory.mkdir(mode=0o755)
        for name, data in files.items():
            atomic_write(directory / name, data)
    for p in [PUBLIC, directory]:
        os.chmod(p, 0o755)
    if shutil.which('restorecon'):
        run('restorecon', '-R', str(PUBLIC))
    return directory, {name: sha(data) for name, data in files.items()}


def candidate_config(original, directory):
    text = original.decode('utf-8')
    if 'epoint_migration_' in text or PREFIX in text or BEGIN in text:
        raise RuntimeError('Migration configuration already exists; review before updating')
    # This guarded deployment edits the known, standalone old-domain server only.
    servers = list(re.finditer(r'(?ms)^server\s*\{\n.*?^\}', text))
    matches = [m for m in servers if re.search(r'(?m)^\s*server_name\s+epoint2api\.fjmooo\.cn\s*;', m.group())]
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one standalone old-domain server')
    match = matches[0]
    server = match.group()
    root = '    location / {\n'
    if server.count(root) != 1 or server.count('proxy_pass http://127.0.0.1:9000;') != 1:
        raise RuntimeError('Unexpected old-domain proxy layout')
    static = f'''    # BEGIN epoint domain migration assets
    location ^~ /__domain-migration/ {{
        alias {directory}/;
        charset utf-8;
        add_header Cache-Control "no-store, max-age=0" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header X-Content-Type-Options "nosniff" always;
    }}
    # END epoint domain migration assets

'''
    updated = server.replace(root, static + root + GATE, 1)
    if updated.replace(static, '', 1).replace(GATE, '', 1) != server:
        raise RuntimeError('Original proxy directives changed')
    maps = BEGIN + MAPS + END + '\n'
    candidate = maps + text[:match.start()] + updated + text[match.end():]
    if candidate.removeprefix(maps).replace(static, '', 1).replace(GATE, '', 1) != text:
        raise RuntimeError('Configuration outside the approved additions changed')
    return candidate.encode(), updated, static


def request(port, host, path, method='GET', headers=None):
    values = {'Host': host, 'Accept': 'text/html', 'User-Agent': 'Sub2API-Migration-Deployment-Check/1.0'}
    values.update(headers or {})
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method, headers=values)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(req, timeout=12)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        data = response.read(2 * 1024 * 1024)
        return {
            'path': path, 'host': host, 'method': method, 'status': response.status,
            'type': response.headers.get_content_type(), 'notice': MARKER in data,
            'cache': response.headers.get('Cache-Control', ''),
            'assets': re.findall(rb'(?:src|href)="(/assets/[^"?]+)', data),
            'length': len(data),
        }


def signatures(port):
    results = [request(port, OLD_HOST, path, method, headers) for path, method, headers in READ_ONLY]
    results.append(request(80, NEW_HOST, '/'))
    return [{k: v for k, v in item.items() if k not in ['length', 'cache']} for item in results]


def check_notice(port):
    results = []
    for path in ['/', '/dashboard?tab=usage', '/users/123', '/login', '/some/deep/page']:
        result = request(port, OLD_HOST, path)
        if result['status'] != 200 or not result['notice'] or result['type'] != 'text/html' or 'no-store' not in result['cache']:
            raise RuntimeError('Notice failed: ' + str(result))
        results.append(result)
    head = request(port, OLD_HOST, '/', 'HEAD')
    if head['status'] != 200 or 'no-store' not in head['cache']:
        raise RuntimeError('Notice HEAD failed')
    results.append(head)
    for file in ['demo.css', 'demo.js', 'lucide.min.js']:
        result = request(port, OLD_HOST, PREFIX + file)
        expected = ['text/css'] if file.endswith('.css') else ['application/javascript', 'text/javascript']
        if result['status'] != 200 or result['type'] not in expected or result['notice'] or result['length'] < 500:
            raise RuntimeError('Static asset failed: ' + str(result))
        results.append(result)
    missing = request(port, OLD_HOST, PREFIX + 'missing.js')
    if missing['status'] != 404:
        raise RuntimeError('Missing static file must remain 404')
    results.append(missing)
    return [{k: v for k, v in item.items() if k != 'assets'} for item in results]


def preflight(stage, server, baseline):
    with socket.socket() as available:
        available.bind(('127.0.0.1', 0))
        port = available.getsockname()[1]
    conf = stage / 'preflight.conf'
    adjusted = server.replace('    listen 80;', f'    listen 127.0.0.1:{port};', 1)
    text = f'''user nginx;
worker_processes 1;
pid {stage}/preflight.pid;
error_log {stage}/preflight-error.log;
events {{ worker_connections 64; }}
http {{
    include /etc/nginx/mime.types;
    access_log off;
    {MAPS}
    {adjusted}
}}
'''
    conf.write_text(text)
    validate(conf)
    process = subprocess.Popen(['nginx', '-p', str(stage) + '/', '-c', str(conf), '-g', 'daemon off;'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while True:
            if process.poll() is not None:
                raise RuntimeError('Preflight Nginx exited; inspect its error log')
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.2):
                    break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError('Preflight Nginx did not become ready')
                time.sleep(.1)
        notices = check_notice(port)
        if signatures(port) != baseline:
            raise RuntimeError('Candidate changed a protected API, callback, method, or new-domain response')
        return notices
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGQUIT)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-dir', type=Path, required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    with open('/run/lock/yunhop-domain.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original = CONFIG.read_bytes()
        if sha(original) != args.expected_sha256:
            raise RuntimeError('Live configuration differs from the reviewed baseline')
        validate()
        active = run('nginx', '-T')
        declarations = re.findall(r'(?m)^\s*server_name\s+[^;]*epoint2api\.fjmooo\.cn[^;]*;', active)
        if len(declarations) != 1 or re.search(r'\b470\b', active):
            raise RuntimeError('Unexpected old-domain declaration or internal status collision')
        if Path('/etc/nginx/aihub-maintenance.flag').exists():
            raise RuntimeError('Existing maintenance mode is active')
        before_configs, before_runtime = config_snapshot(), runtime_snapshot()
        baseline = signatures(80)
        stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M%S-%f')
        backup = Path('/root/sub2api-deploy/backups') / ('epoint-domain-migration-' + stamp)
        backup.mkdir(mode=0o700)
        shutil.copy2(CONFIG, backup / 'migrated-services.conf.before')
        directory, asset_hashes = bundle(args.assets_dir)
        candidate, server, _ = candidate_config(original, directory)
        stage = backup / 'candidate'
        (stage / 'conf.d').mkdir(parents=True)
        for path in Path('/etc/nginx/conf.d').glob('*.conf'):
            (stage / 'conf.d' / path.name).write_bytes(candidate if path == CONFIG else path.read_bytes())
        main = Path('/etc/nginx/nginx.conf').read_bytes()
        include = b'include /etc/nginx/conf.d/*.conf;'
        if main.count(include) != 1:
            raise RuntimeError('Unexpected main configuration include layout')
        main_conf = stage / 'nginx-validation.conf'
        main_conf.write_bytes(main.replace(include, b'include ' + str(stage / 'conf.d/*.conf').encode() + b';'))
        validation = validate(main_conf)
        preflight_results = preflight(stage, server, baseline)
        manifest = {
            'applied': False, 'backup': str(backup), 'configuration': str(CONFIG),
            'before_sha256': sha(original), 'after_sha256': sha(candidate),
            'release': str(directory), 'asset_sha256': asset_hashes,
            'runtime_before': before_runtime, 'configs_before': before_configs,
            'candidate_validation': validation, 'protected_routes_verified': len(baseline),
            'preflight': preflight_results,
        }
        manifest_path = backup / 'manifest.json'
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(json.dumps({'prepared': True, 'backup': str(backup), 'release': str(directory), 'protected_routes_verified': len(baseline), 'notice_checks': len(preflight_results)}), flush=True)
        if not args.apply:
            return
        installed = False
        try:
            if config_snapshot() != before_configs or runtime_snapshot() != before_runtime:
                raise RuntimeError('Production changed during preflight')
            atomic_write(CONFIG, candidate, backup / 'migrated-services.conf.before')
            installed = True
            validate()
            run('systemctl', 'reload', 'nginx')
            deadline = time.monotonic() + 10
            while not request(80, OLD_HOST, '/')['notice']:
                if time.monotonic() > deadline:
                    raise RuntimeError('Reload did not activate the notice')
                time.sleep(.2)
            manifest['origin_verification'] = check_notice(80)
            if signatures(80) != baseline:
                raise RuntimeError('Protected route response changed after reload')
            expected_configs = dict(before_configs)
            expected_configs[str(CONFIG)] = sha(candidate)
            if config_snapshot() != expected_configs or runtime_snapshot() != before_runtime:
                raise RuntimeError('Unexpected configuration, container, or master process change')
            manifest['applied'] = True
            manifest['runtime_unchanged'] = True
            manifest['other_nginx_configs_unchanged'] = True
            manifest['rollback_command'] = f'python3 {Path(__file__).resolve().parent}/rollback-nginx.py {backup}'
        except Exception as error:
            manifest['error'] = str(error)
            if installed:
                if sha(CONFIG.read_bytes()) != sha(candidate):
                    manifest['rollback_blocked'] = 'Concurrent configuration change'
                else:
                    atomic_write(CONFIG, original, backup / 'migrated-services.conf.before')
                    validate()
                    run('systemctl', 'reload', 'nginx')
                    manifest['rolled_back'] = True
            raise
        finally:
            manifest_path.write_text(json.dumps(manifest, indent=2))
        print(json.dumps({'applied': True, 'backup': str(backup), 'release': str(directory), 'containers_unchanged': True, 'nginx_and_x_ui_master_unchanged': True, 'other_nginx_configs_unchanged': True}), flush=True)


if __name__ == '__main__':
    main()

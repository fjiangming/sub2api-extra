#!/usr/bin/env python3
"""Validate additive yunhop.cc routes; install only with --apply."""

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import subprocess


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, check=True)
    return result.stdout + result.stderr


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def containers():
    values = json.loads(run("docker", "inspect", *run("docker", "ps", "-q").split()))
    return {v["Name"]: [v["Id"], v["State"]["StartedAt"]] for v in values}


def atomic_write(path, data, original=None):
    temporary = path.with_name(path.name + ".yunhop-new")
    with temporary.open("xb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, original.stat().st_mode & 0o777 if original else 0o644)
    if original:
        stat = original.stat()
        os.chown(temporary, stat.st_uid, stat.st_gid)
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    arguments = parser.parse_args()
    os.umask(0o077)
    lock = open("/run/lock/yunhop-domain.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    source = pathlib.Path(__file__).resolve().parent
    nginx = pathlib.Path("/etc/nginx")
    protected = [pathlib.Path(p) for p in [
        "/usr/local/x-ui/bin/config.json", "/etc/ssl/3x-ui/cert.pem",
        "/etc/ssl/3x-ui/privkey.pem", "/etc/3x-sub/app.py",
    ]]
    protected_before = {str(p): digest(p) for p in protected}
    container_before = containers()
    main_pid = run("systemctl", "show", "nginx", "-p", "MainPID", "--value").strip()
    certificate = nginx / "ssl/yunhop.cc/origin.pem"
    private_key = nginx / "ssl/yunhop.cc/origin.key"
    run("openssl", "verify", "-CAfile", str(certificate.parent / "cloudflare-origin-ca.pem"),
        "-verify_hostname", "yunhop.cc", str(certificate))
    if run("openssl", "x509", "-in", str(certificate), "-pubkey", "-noout") != run(
            "openssl", "pkey", "-in", str(private_key), "-pubout"):
        raise RuntimeError("Certificate and key do not match")
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d-%H%M%S-%f")
    backup = pathlib.Path("/root/sub2api-deploy/backups") / ("yunhop-domain-" + stamp)
    backup.mkdir(mode=0o700)
    stage = backup / "candidate"
    (stage / "conf.d").mkdir(parents=True)
    changes = {
        nginx / "conf.d/yunhop-services.conf": (source / "yunhop-services.conf").read_bytes(),
        nginx / "snippets/yunhop-tls.conf": (source / "yunhop-tls.conf").read_bytes(),
        nginx / "snippets/yunhop-proxy.conf": (source / "yunhop-proxy.conf").read_bytes(),
    }
    parents = b"https://yunhop.cc https://www.yunhop.cc"
    canvas = nginx / "conf.d/infinite-canvas.conf"
    data = canvas.read_bytes()
    if parents not in data:
        old = b"https://epoint2api.fjmooo.cn\" always;"
        if data.count(old) != 1:
            raise RuntimeError("Unexpected standalone canvas CSP")
        data = data.replace(old, b"https://epoint2api.fjmooo.cn " + parents + b'" always;')
    changes[canvas] = data.replace(b"return 302 https://canvas.fo2.us.ci$uri;", b"return 302 https://$host$uri;")
    canvas_main = nginx / "snippets/infinite-canvas-main.conf"
    data = canvas_main.read_bytes()
    if parents not in data:
        old = b"https://epoint2api.fjmooo.cn\" always;"
        if data.count(old) != 1:
            raise RuntimeError("Unexpected main-site canvas CSP")
        data = data.replace(old, b"https://epoint2api.fjmooo.cn https://aihub.fo2.us.ci " + parents + b'" always;')
    data = data.replace(b"return 302 https://aihub.fo2.us.ci/canvas/;", b"return 302 https://$host/canvas/;")
    data = data.replace(b"return 302 /canvas/;", b"return 302 https://$host/canvas/;")
    changes[canvas_main] = data.replace(b"return 302 https://aihub.fo2.us.ci$uri;", b"return 302 https://$host$uri;")
    replacements = {
        b"/etc/nginx/snippets/yunhop-tls.conf": str(stage / "yunhop-tls.conf").encode(),
        b"/etc/nginx/snippets/yunhop-proxy.conf": str(stage / "yunhop-proxy.conf").encode(),
        b"/etc/nginx/snippets/infinite-canvas-main.conf": str(stage / "infinite-canvas-main.conf").encode(),
    }
    for path in nginx.glob("conf.d/*.conf"):
        data = changes.get(path, path.read_bytes())
        for old, new in replacements.items():
            data = data.replace(old, new)
        (stage / "conf.d" / path.name).write_bytes(data)
    data = changes[nginx / "conf.d/yunhop-services.conf"]
    for old, new in replacements.items():
        data = data.replace(old, new)
    (stage / "conf.d/yunhop-services.conf").write_bytes(data)
    for name in ["yunhop-tls.conf", "yunhop-proxy.conf", "infinite-canvas-main.conf"]:
        (stage / name).write_bytes(changes[nginx / "snippets" / name])
    main = (nginx / "nginx.conf").read_bytes()
    include = b"include /etc/nginx/conf.d/*.conf;"
    if main.count(include) != 1:
        raise RuntimeError("Unexpected Nginx include layout")
    validation = stage / "nginx-validation.conf"
    validation.write_bytes(main.replace(include, b"include " + str(stage / "conf.d/*.conf").encode() + b";"))
    print(run("nginx", "-t", "-c", str(validation)), flush=True)
    manifest = {"backup": str(backup), "protected": protected_before, "containers": container_before,
                "nginx_pid": main_pid, "before": {str(p): digest(p) for p in changes},
                "after": {str(p): hashlib.sha256(v).hexdigest() for p, v in changes.items()}, "applied": False}
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"backup": str(backup), "validated_files": [str(p) for p in changes]}), flush=True)
    if not arguments.apply:
        return
    installed = []
    try:
        for path, data in changes.items():
            if digest(path) != manifest["before"][str(path)]:
                raise RuntimeError("Configuration changed during validation: " + str(path))
            original = backup / "before" / str(path).lstrip("/")
            if path.exists():
                original.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, original)
            atomic_write(path, data, original if original.exists() else None)
            installed.append(path)
        print(run("nginx", "-t"), flush=True)
        run("systemctl", "reload", "nginx")
        if {str(p): digest(p) for p in protected} != protected_before or containers() != container_before:
            raise RuntimeError("Protected service state changed; inspect before proceeding")
        if run("systemctl", "show", "nginx", "-p", "MainPID", "--value").strip() != main_pid:
            raise RuntimeError("Nginx master changed unexpectedly")
        manifest["applied"] = True
    except Exception:
        for path in reversed(installed):
            if digest(path) != manifest["after"][str(path)]:
                raise RuntimeError("Concurrent change prevents rollback: " + str(path))
            original = backup / "before" / str(path).lstrip("/")
            if original.exists():
                atomic_write(path, original.read_bytes(), original)
            else:
                path.unlink()
        run("nginx", "-t")
        run("systemctl", "reload", "nginx")
        raise
    finally:
        (backup / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"applied": True, "backup": str(backup), "containers_unchanged": True,
                      "excluded_configurations_unchanged": True, "nginx_master_unchanged": True}))


if __name__ == "__main__":
    main()

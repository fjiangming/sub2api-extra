#!/usr/bin/env python3
"""Install reviewed aliases in the original Nginx files; apply only with --apply."""

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


def validate_nginx(*args):
    output = run("nginx", "-t", *args)
    if "conflicting server name" in output.lower() or "duplicate" in output.lower():
        raise RuntimeError("Nginx candidate contains a conflicting declaration: " + output)
    print(output, flush=True)


def containers():
    values = json.loads(run("docker", "inspect", *run("docker", "ps", "-q").split()))
    return {v["Name"]: [v["Id"], v["State"]["StartedAt"]] for v in values}


def atomic_write(path, data, original=None):
    if data is None:
        if path.exists():
            path.unlink()
        return
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
    approved = source / "original-files"
    review = json.loads((approved / "validation.json").read_text())
    nginx = pathlib.Path("/etc/nginx")
    changes = {nginx / "conf.d" / name: (approved / name).read_bytes() for name in [
        "migrated-services.conf", "recharge-center.conf", "usage-leaderboard.conf", "infinite-canvas.conf",
    ]}
    changes[nginx / "snippets/yunhop-tls.conf"] = (approved / "yunhop-tls.conf").read_bytes()
    for name in ["sub2api-main-proxy.conf", "canvas-api-cors.conf"]:
        changes[nginx / "snippets" / name] = (approved / name).read_bytes()
    changes[nginx / "snippets/yunhop-proxy.conf"] = None
    changes[nginx / "conf.d/yunhop-services.conf"] = None
    desired = {str(p): hashlib.sha256(data).hexdigest() if data is not None else None for p, data in changes.items()}
    if desired != review["candidate_sha256"]:
        raise RuntimeError("Reviewed candidate content changed; verify the configuration again")
    if set(desired) - set(review["baseline_sha256"]):
        raise RuntimeError("Candidate contains an unreviewed target")
    current = {path: digest(pathlib.Path(path)) for path in review["baseline_sha256"]}
    if all(current[path] == desired.get(path, before) for path, before in review["baseline_sha256"].items()):
        print(json.dumps({"already_applied": True, "reload_required": False}))
        return
    if current != review["baseline_sha256"]:
        raise RuntimeError("Production configuration changed since review; regenerate without overwriting edits")
    protected = [pathlib.Path(p) for p in [
        "/usr/local/x-ui/bin/config.json", "/etc/ssl/3x-ui/cert.pem",
        "/etc/ssl/3x-ui/privkey.pem", "/etc/3x-sub/app.py",
        "/etc/nginx/ssl/yunhop.cc/origin.pem", "/etc/nginx/ssl/yunhop.cc/origin.key",
        "/etc/nginx/ssl/yunhop.cc/cloudflare-origin-ca.pem",
    ]]
    protected += [pathlib.Path(p) for p in review["baseline_sha256"] if pathlib.Path(p) not in changes]
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
    replacements = {
        b"/etc/nginx/snippets/yunhop-tls.conf": str(stage / "yunhop-tls.conf").encode(),
        b"/etc/nginx/snippets/sub2api-main-proxy.conf": str(stage / "sub2api-main-proxy.conf").encode(),
        b"/etc/nginx/snippets/canvas-api-cors.conf": str(stage / "canvas-api-cors.conf").encode(),
    }
    for path in nginx.glob("conf.d/*.conf"):
        data = changes.get(path, path.read_bytes())
        if data is None:
            continue
        for old, new in replacements.items():
            data = data.replace(old, new)
        (stage / "conf.d" / path.name).write_bytes(data)
    (stage / "yunhop-tls.conf").write_bytes(changes[nginx / "snippets/yunhop-tls.conf"])
    for name in ["sub2api-main-proxy.conf", "canvas-api-cors.conf"]:
        (stage / name).write_bytes(changes[nginx / "snippets" / name])
    main = (nginx / "nginx.conf").read_bytes()
    include = b"include /etc/nginx/conf.d/*.conf;"
    if main.count(include) != 1:
        raise RuntimeError("Unexpected Nginx include layout")
    validation = stage / "nginx-validation.conf"
    validation.write_bytes(main.replace(include, b"include " + str(stage / "conf.d/*.conf").encode() + b";"))
    validate_nginx("-c", str(validation))
    manifest = {"backup": str(backup), "protected": protected_before, "containers": container_before,
                "nginx_pid": main_pid, "before": {str(p): digest(p) for p in changes},
                "after": desired, "applied": False}
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"backup": str(backup), "validated_files": [str(p) for p in changes],
                      "deleted_files": [str(p) for p, value in changes.items() if value is None]}), flush=True)
    if not arguments.apply:
        return
    installed = []
    try:
        if {str(p): digest(p) for p in protected} != protected_before:
            raise RuntimeError("Protected configuration changed during validation")
        for path, data in changes.items():
            if digest(path) != manifest["before"][str(path)]:
                raise RuntimeError("Configuration changed during validation: " + str(path))
            if digest(path) == desired[str(path)]:
                continue
            original = backup / "before" / str(path).lstrip("/")
            if path.exists():
                original.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, original)
            atomic_write(path, data, original if original.exists() else None)
            installed.append(path)
        if {str(p): digest(p) for p in changes} != desired:
            raise RuntimeError("Installed content does not match the reviewed candidate")
        validate_nginx()
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
                atomic_write(path, None)
        run("nginx", "-t")
        run("systemctl", "reload", "nginx")
        raise
    finally:
        (backup / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"applied": True, "backup": str(backup), "containers_unchanged": True,
                      "excluded_configurations_unchanged": True, "nginx_master_unchanged": True,
                      "separate_services_file_removed": not (nginx / "conf.d/yunhop-services.conf").exists()}))


if __name__ == "__main__":
    main()

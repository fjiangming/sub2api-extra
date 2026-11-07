#!/usr/bin/env python3
"""Validate four explicit domain allowlists; --apply updates env files only."""

import argparse
import copy
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile


ROOT = pathlib.Path("/root/sub2api-extra")
SERVICES = ("recharge-center", "operations-center", "provider-monitor", "usage-leaderboard")
MAIN_ORIGINS = "https://yunhop.cc,https://www.yunhop.cc,https://epoint2api.fjmooo.cn,https://aihubdirect.fo2.us.ci"


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Command failed: " + " ".join(args[:3]))
    return result.stdout


def compose(override=None):
    command = ["docker", "compose", "--project-directory", str(ROOT),
               "--env-file", str(ROOT / "compose.services.env"), "-f", str(ROOT / "docker-compose.yml")]
    if override:
        command += ["-f", str(override)]
    return json.loads(run(*command, "config", "--format", "json"))


def containers():
    identifiers = run("docker", "ps", "-q").split()
    if not identifiers:
        raise RuntimeError("No running containers")
    values = json.loads(run("docker", "inspect", *identifiers))
    return {v["Name"]: [v["Id"], v["State"]["StartedAt"]] for v in values}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data, metadata):
    descriptor, name = tempfile.mkstemp(prefix=path.name + ".yunhop-", dir=path.parent)
    temporary = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, metadata.st_mode & 0o777)
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Run as root")
    os.umask(0o077)
    with open("/run/lock/yunhop-domain.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = compose()
        container_before = containers()
        expected = copy.deepcopy(before)
        stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d-%H%M%S-%f")
        backup = pathlib.Path("/root/sub2api-deploy/backups") / ("yunhop-app-env-" + stamp)
        backup.mkdir(mode=0o700)
        changes = {}
        override = {"services": {}}
        for name in SERVICES:
            path = ROOT / name / ".env"
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("Expected regular env file: " + str(path))
            original = path.read_bytes()
            additions = {"SUB2API_PUBLIC_URLS": MAIN_ORIGINS}
            if name == "recharge-center":
                additions["RECHARGE_CENTER_PUBLIC_URLS"] = "https://aihubpay.yunhop.cc"
            environment = before["services"][name]["environment"]
            lines = original.decode("utf-8").splitlines()
            for key, value in additions.items():
                # Existing different aliases require an explicit merge, never replacement.
                if environment.get(key) not in (None, "", value):
                    raise RuntimeError("Existing allowlist needs review: " + name + "/" + key)
                occurrences = [line for line in lines if re.match(r"^\s*(?:export\s+)?" + key + r"\s*=", line)]
                if occurrences and environment.get(key) != value:
                    raise RuntimeError("Existing env assignment needs review: " + name + "/" + key)
                if not occurrences:
                    if original and not original.endswith(b"\n"):
                        original += b"\n"
                    original += (key + "=" + value + "\n").encode("ascii")
                expected["services"][name]["environment"][key] = value
            source = path.read_bytes()
            changes[path] = (source, original, path.stat())
            saved = backup / "before" / name / ".env"
            saved.parent.mkdir(parents=True)
            shutil.copy2(path, saved)
            os.chmod(saved, 0o600)
            candidate = backup / "candidate" / name / ".env"
            candidate.parent.mkdir(parents=True)
            candidate.write_bytes(original)
            override["services"][name] = {"env_file": [str(candidate)]}
        override_path = backup / "compose.override.json"
        override_path.write_text(json.dumps(override))
        if compose(override_path) != expected:
            raise RuntimeError("Candidate Compose changes exceed explicit allowlists")
        manifest = {"backup": str(backup), "applied": False, "containers_unchanged": True,
                    "before": {str(p): digest(v[0]) for p, v in changes.items()},
                    "after": {str(p): digest(v[1]) for p, v in changes.items()},
                    "keys": {n: ["SUB2API_PUBLIC_URLS"] +
                             (["RECHARGE_CENTER_PUBLIC_URLS"] if n == "recharge-center" else []) for n in SERVICES}}
        manifest_path = backup / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2))
        if arguments.apply:
            installed = []
            try:
                if compose() != before:
                    raise RuntimeError("Compose changed during validation")
                for path, (source, candidate, metadata) in changes.items():
                    if path.read_bytes() != source:
                        raise RuntimeError("Concurrent env edit: " + str(path))
                    atomic_write(path, candidate, metadata)
                    installed.append(path)
                if compose() != expected or containers() != container_before:
                    raise RuntimeError("Post-install configuration or container state mismatch")
                manifest["applied"] = True
            except Exception:
                for path in reversed(installed):
                    source, candidate, metadata = changes[path]
                    if path.read_bytes() != candidate:
                        raise RuntimeError("Concurrent change prevents rollback: " + str(path))
                    atomic_write(path, source, metadata)
                raise
            finally:
                manifest_path.write_text(json.dumps(manifest, indent=2))
        print(json.dumps({"backup": str(backup), "applied": manifest["applied"],
                          "services": list(SERVICES), "containers_unchanged": containers() == container_before}))


if __name__ == "__main__":
    main()

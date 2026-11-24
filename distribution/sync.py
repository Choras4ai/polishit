"""Mirror the exact installers recorded by the official updater or release archive."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import tempfile

version = os.environ["VERSION"]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise ValueError("Invalid version")
tag = f"v{version}"
base = "https://www.runshi.top"
history = json.loads(Path("distribution/history.json").read_text())
live = json.loads(subprocess.check_output(["curl", "-fsSL", "--retry", "3", base + "/version.json"]))
current = version == live["version"]
names = {"darwin-arm64": f"runshi-polis-{version}-arm64.dmg", "win32-x64": f"runshi-polis-setup-{version}.exe"}
if current:
    files = {name: live["sha256"][platform] for platform, name in names.items()}
    for platform, name in names.items():
        assert live["downloads"][platform] == base + "/downloads/" + name
else:
    files = history[version]
    assert set(files).issubset(names.values()) and files

def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)

with tempfile.TemporaryDirectory() as root:
    notes = [live["notes"] if current else "历史版本归档。下列文件已与官网下载存档逐字节校验。", "", "### SHA-256", ""]
    assets = []
    for name, digest in files.items():
        p = Path(root) / name
        subprocess.run(["curl", "-fsSL", "--retry", "3", "--connect-timeout", "20", "--max-time", "1200", "-o", str(p), base + "/downloads/" + name], check=True)
        with p.open("rb") as handle:
            if hashlib.file_digest(handle, "sha256").hexdigest() != digest:
                raise RuntimeError(f"Installer checksum mismatch: {name}")
        notes.append(f"- `{name}` · `{digest}`")
        assets.append(p)
    if len(files) == 1:
        notes.append("\n本次归档仅找到 macOS 安装包。")
    note = Path(root) / "notes.md"
    note.write_text("\n".join(notes) + "\n")
    existing = subprocess.run(["gh","release","view",tag,"--json","isDraft,assets"],capture_output=True,text=True)
    if existing.returncode:
        gh("release","create",tag,"--draft","--title","润石 PoliShit "+tag,"--notes-file",str(note))
        entries = []
    else:
        entries = json.loads(existing.stdout)["assets"]
    for p in assets:
        old = next((a for a in entries if a["name"]==p.name),None)
        if old:
            if old.get("digest") != "sha256:" + files[p.name]:
                raise RuntimeError("Existing release asset differs: "+p.name)
        else:
            gh("release","upload",tag,str(p))
    gh("release","edit",tag,"--draft=false","--latest="+str(current).lower(),"--notes-file",str(note))

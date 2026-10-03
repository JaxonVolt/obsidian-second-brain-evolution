"""Create the five-file plugin bundle and checksums from verified build outputs."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
names = ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'NOTICE.md']
out = root / 'release'
out.mkdir(exist_ok=True)
archive = out / f"{manifest['id']}-{manifest['version']}.zip"
for name in names[:3]:
    (out / name).write_bytes((root / name).read_bytes())
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for name in names:
        info = zipfile.ZipInfo(f"{manifest['id']}/{name}", (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        bundle.writestr(info, (root / name).read_bytes())
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    assert sorted(bundle.namelist()) == sorted(f"{manifest['id']}/{name}" for name in names)
    for name in names:
        assert bundle.read(f"{manifest['id']}/{name}") == (root / name).read_bytes()
lines = [f"{hashlib.sha256((out / name).read_bytes()).hexdigest()}  {name}"
         for name in [*names[:3], archive.name]]
(out / 'SHA256SUMS.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(f"Verified package: {archive.name}, {len(names)} files")

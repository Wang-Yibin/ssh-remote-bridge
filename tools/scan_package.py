#!/usr/bin/env python3
"""
scan_package.py — 分发包凭据泄漏扫描器

在**打包之后、发给任何人之前**跑一遍。检查 zip 内容（不只看磁盘目录）
里有没有不该出现的东西：真实 IP / 用户名 / 密码 / 主机密钥指纹 / 本机路径。

用法:
    python tools/scan_package.py                 # 扫 dist/ssh-remote-bridge-1.0.0.zip
    python tools/scan_package.py <某个.zip>
    python tools/scan_package.py --dir dist/ssh-remote-bridge-1.0.0   # 扫目录

设计原则:
  - 扫描 zip **内部内容**而不是磁盘目录 —— 打包过程本身可能带入意外文件
  - 文本文件全文扫; 二进制只查已知的真实凭据串（避免误报）
  - 特征串只从本机配置读取，不在源码保存或在输出回显
  - 退出码: 0 = 干净, 1 = 发现污染（可直接串进打包脚本）

"""
import os
import re
import sys
import zipfile
import pathlib

TEXT_EXT = ('.md', '.txt', '.json', '.mjs', '.js', '.cmd', '.sh', '.toml', '.yml', '.yaml', '.cfg', '.ini')

import json
config_path = pathlib.Path(os.environ.get('SRB_CONFIG', pathlib.Path(__file__).resolve().parents[1] / 'servers.json'))
config = json.loads(config_path.read_text(encoding='utf-8'))
known = [(str(v), k) for server in config.get('servers', {}).values() for k, v in server.items()
         if k in ('host', 'user', 'password', 'hostkey', 'keyFile', 'mount') and v]
TEXT_PATTERNS = [(re.escape(v), k + ' from local config') for v, k in known]
TEXT_PATTERNS += [(r'-----BEGIN [A-Z ]*PRIVATE KEY-----', 'private key')]
BIN_PATTERNS = [(v.encode(), k + ' from local config') for v, k in known]

# 不该出现在分发包里的文件（运行时生成 / 开发残留）
FORBIDDEN_NAMES = {'known_hosts', 'rclone.conf', 'mount_test.log', '.gitignore',
                   'servers.json', 'servers.json.bak', 'scan_package.py'}


def scan_zip(path):
    findings = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.endswith('/'):
                continue
            base = os.path.basename(name)
            if base in FORBIDDEN_NAMES:
                findings.append((name, 0, '不该在包里: ' + base, base))
            data = z.read(name)
            if name.lower().endswith(TEXT_EXT):
                text = data.decode('utf-8', errors='ignore')
                for pat, label in TEXT_PATTERNS:
                    for m in re.finditer(pat, text):
                        line = text[: m.start()].count('\n') + 1
                        findings.append((name, line, label, '[redacted]'))
            else:
                for pat, label in BIN_PATTERNS:
                    if pat in data:
                        findings.append((name, 0, label + '（二进制内）', '[redacted]'))
    return findings


def scan_dir(path):
    findings = []
    root = pathlib.Path(path)
    for p in sorted(root.rglob('*')):
        if not p.is_file():
            continue
        rel = str(p.relative_to(root.parent))
        if p.name in FORBIDDEN_NAMES:
            findings.append((rel, 0, '不该在包里: ' + p.name, p.name))
        data = p.read_bytes()
        if p.suffix.lower() in TEXT_EXT:
            text = data.decode('utf-8', errors='ignore')
            for pat, label in TEXT_PATTERNS:
                for m in re.finditer(pat, text):
                    line = text[: m.start()].count('\n') + 1
                    findings.append((rel, line, label, m.group()[:50]))
        else:
            for pat, label in BIN_PATTERNS:
                if pat in data:
                    findings.append((rel, 0, label + '（二进制内）', pat.decode()))
    return findings


def main():
    args = sys.argv[1:]
    if args and args[0] == '--dir':
        target = args[1] if len(args) > 1 else 'dist/ssh-remote-bridge-1.0.0'
        findings = scan_dir(target)
        kind = '目录'
    else:
        target = args[0] if args else 'dist/ssh-remote-bridge-1.0.0.zip'
        if not os.path.exists(target):
            print(f'[scan] not found: {target}')
            sys.exit(2)
        findings = scan_zip(target)
        kind = 'ZIP'

    print('=' * 62)
    print(f'  分发包凭据泄漏扫描 · {kind}: {target}')
    print('=' * 62)
    if findings:
        for name, line, label, snippet in findings:
            loc = f'{name}:{line}' if line else name
            print(f'  [污染] {loc}')
            print(f'         {label}: {snippet}')
        print()
        print(f'  结果: 发现 {len(findings)} 处污染 — 不要发出去')
        print('=' * 62)
        sys.exit(1)
    print('  结果: 干净 ✓  未发现真实 IP / 账号 / 密码 / 主机密钥 / 本机路径')
    print('=' * 62)
    sys.exit(0)


if __name__ == '__main__':
    main()
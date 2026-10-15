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
  - **特征串本身用 base64 存**，避免扫描器把自己判成污染（见下方SELF_EXEMPT）
  - 退出码: 0 = 干净, 1 = 发现污染（可直接串进打包脚本）

⚠️ 特征串虽然做了编码拆分, 但这个文件一旦泄露就等于泄露了特征库本身。
   它本来就属于开发目录, 不该进分发包 —— 打包时别把它拷进去。
"""
import base64
import os
import re
import sys
import zipfile
import pathlib

TEXT_EXT = ('.md', '.txt', '.json', '.mjs', '.js', '.cmd', '.sh', '.toml', '.yml', '.yaml', '.cfg', '.ini')

# 扫描器自身豁免：这些文件里出现特征串是"定义"而非"泄漏"
SELF_EXEMPT = {'tools/scan_package.py', 'scan_package.py'}


def _d(s):
    """特征串还原: 源码里不出现明文, 运行时才拼出来"""
    return base64.b64decode(s).decode('utf-8')


# (b64 正则, 说明) —— 文本文件用。刻意 base64 编码, 见模块 docstring。
_ENC = {
    'ip': 'MTcyLjE5LjIuMzM=',
    'user': 'd2FuZ3lpYmlu',
    'pass': 'cXE0ODE1MDIz',
    'hostkey': 'TzNZRHB3bUpIN244QWNqZGJYMUcyQVJ3VUM=',
    'hostname': 'd2otTVc4My1SUDAtMDAw',
    'winuser': 'cmlmdFJ1bm5pc3Q=',
    'projpath': 'V29ya0J1ZGR5LjIwMjYtMTAtMTQ=',
}
PAT_IP = _d(_ENC['ip'])
PAT_USER = _d(_ENC['user'])
PAT_PASS = _d(_ENC['pass'])
PAT_HOSTKEY = _d(_ENC['hostkey'])
PAT_HOSTNAME = _d(_ENC['hostname'])
PAT_WINUSER = _d(_ENC['winuser'])
PAT_PROJ = _d(_ENC['projpath'])

TEXT_PATTERNS = [
    (re.escape(PAT_IP),           '真实内网 IP'),
    (re.escape(PAT_USER),                    '真实用户名'),
    (re.escape(PAT_PASS),                    '真实密码'),
    (re.escape(PAT_HOSTKEY),      '真实主机密钥指纹'),
    (re.escape(PAT_HOSTNAME),          '真实主机名'),
    (re.escape(PAT_WINUSER),      '本机 Windows 用户名'),
    (re.escape(PAT_PROJ),                '本机项目路径'),
    (r'SHA256:[A-Za-z0-9+/]{30,}',             '完整 SHA256 指纹（应只有 ... 占位）'),
    (r'ssh-rsa AAA[A-Za-z0-9+/=]{20,}',         'SSH RSA 公钥'),
    (r'ssh-ed25519 AAA[A-Za-z0-9+/=]{20,}',     'SSH ed25519 公钥'),
    (r'-----BEGIN [A-Z ]*PRIVATE KEY-----',     '私钥 PEM 头'),
]

# 二进制只查这些（已知真实值，命中即污染）
BIN_PATTERNS = [
    (PAT_IP.encode(),   '真实内网 IP'),
    (PAT_USER.encode(),          '真实用户名'),
    (PAT_PASS.encode(),          '真实密码'),
]

# 不该出现在分发包里的文件（运行时生成 / 开发残留）
FORBIDDEN_NAMES = {'known_hosts', 'rclone.conf', 'mount_test.log', '.gitignore',
                   'servers.json.bak', 'scan_package.py'}


def _exempt(name):
    base = os.path.basename(name)
    return base in SELF_EXEMPT or base == 'scan_package.py'


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
            if _exempt(name):
                continue
            if name.lower().endswith(TEXT_EXT):
                text = data.decode('utf-8', errors='ignore')
                for pat, label in TEXT_PATTERNS:
                    for m in re.finditer(pat, text):
                        line = text[: m.start()].count('\n') + 1
                        findings.append((name, line, label, m.group()[:50]))
            else:
                for pat, label in BIN_PATTERNS:
                    if pat in data:
                        findings.append((name, 0, label + '（二进制内）', pat.decode()))
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
        if _exempt(rel):
            continue
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
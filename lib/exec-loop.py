"""SSH command controller: block on input, output or SIGCHLD instead of polling."""
import base64
import collections
import ctypes
import os
import re
import selectors
import shutil
import signal
import subprocess
import sys
import time

ROOT = os.environ['SRB_DIR']
LIMIT = 2 * 1024 * 1024
TOKEN = re.compile(r'^[we][0-9]+$')
SHELL = r'''
srb_state() {
  local ec=$? line name
  printf '%s' "$PWD" > "$SRB_TASK/pwd"
  if [ "$SRB_ISOLATED" != 1 ]; then
    {
      while read -r name; do [[ -v "$name" ]] || printf 'unset %q\n' "$name"; done < "$SRB_DIR/base-vars"
      printf 'cd %q\n' "$PWD"
      while IFS= read -r line; do
        case "$line" in 'declare -x SRB_TASK='*|'declare -x SRB_ISOLATED='*) continue;; esac
        printf '%s\n' "${line/#declare -x /export }"
      done < <(export -p)
    } > "$SRB_STATE.new"
    /bin/mv -f "$SRB_STATE.new" "$SRB_STATE"
  fi
  return "$ec"
}
if [ "$SRB_ISOLATED" != 1 ] && [ -f "$SRB_STATE" ]; then . "$SRB_STATE"; fi
trap srb_state EXIT
. "$SRB_TASK/cmd"
exit $?
'''


def emit(kind, token, data=''):
    sys.stdout.buffer.write(('%s %s %s\n' % (kind, token, data)).encode('ascii'))
    sys.stdout.buffer.flush()


def b64(data):
    return base64.b64encode(data).decode('ascii')


def kill_group(pid, sig):
    try:
        os.killpg(pid, sig)
        return True
    except ProcessLookupError:
        return False


class Task:
    def __init__(self, mode, token, command, budget, timeout):
        self.mode, self.token, self.budget = mode, token, budget
        self.path = os.path.join(ROOT, token)
        os.mkdir(self.path)
        with open(self.path + '/cmd', 'wb') as f:
            f.write(command)
        self.out = open(self.path + '/out', 'w+b', buffering=0)
        self.size = self.notified = 0
        self.limited = False
        self.notify_at = 0
        self.deadline = time.monotonic() + timeout
        self.kill_at = None
        self.cancelled = False
        env = dict(os.environ, SRB_TASK=self.path, SRB_ISOLATED=str(int(mode in 'EJ')))
        self.proc = subprocess.Popen(['/bin/bash', '-c', SHELL], env=env,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        os.set_blocking(self.proc.stdout.fileno(), False)

    def collect(self, data):
        if self.mode == 'F':
            emit('S', self.token, b64(data))
            return
        remaining = LIMIT - self.size
        if len(data) > remaining and not self.limited:
            self.limited = True
            emit('L', self.token, '1')
        data = data[:remaining]
        self.out.write(data)
        self.size += len(data)

    def notify(self, now):
        if self.mode == 'J' and self.size != self.notified and now >= self.notify_at:
            emit('V', self.token, str(self.size))
            self.notified, self.notify_at = self.size, now + .2


class Controller:
    def __init__(self):
        self.selector = selectors.DefaultSelector()
        os.set_blocking(0, False)
        self.selector.register(0, selectors.EVENT_READ, 'input')
        self.wake_read, self.wake_write = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        signal.set_wakeup_fd(self.wake_write)
        signal.signal(signal.SIGCHLD, lambda *_: None)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda *_: sys.exit(143))
        # Reap command descendants ourselves; some servers' PID 1 does not reap them.
        ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
        self.selector.register(self.wake_read, selectors.EVENT_READ, 'signal')
        self.active = None
        self.history = collections.deque()
        self.orphans = {}
        self.buffer = bytearray()

    def reap(self):
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if not pid:
                return
            if self.active and pid == self.active.proc.pid:
                self.active.proc.returncode = os.waitstatus_to_exitcode(status)

    def evict(self):
        now = time.monotonic()
        while self.history and (len(self.history) > 16 or now - self.history[0][0] >= 600):
            _, path = self.history.popleft()
            shutil.rmtree(path)

    def interrupt(self, timed_out=False):
        task = self.active
        if not task or task.cancelled:
            return
        task.cancelled = True
        if timed_out:
            emit('U', task.token, 'timeout')
        kill_group(task.proc.pid, signal.SIGTERM)
        task.kill_at = time.monotonic() + 2

    def finish(self):
        task = self.active
        # Only drain buffered bytes; inherited output pipes must not keep a task alive.
        for _ in range(32):
            try:
                data = os.read(task.proc.stdout.fileno(), 32768)
            except BlockingIOError:
                break
            if not data:
                break
            task.collect(data)
        try:
            self.selector.unregister(task.proc.stdout)
        except KeyError:
            pass
        task.proc.stdout.close()
        task.out.close()
        if kill_group(task.proc.pid, signal.SIGTERM):
            self.orphans[task.proc.pid] = time.monotonic() + 2
        try:
            with open(task.path + '/pwd', 'rb') as f:
                cwd = f.read()
        except FileNotFoundError:
            cwd = b''
        emit('P', task.token, b64(cwd))
        if task.mode in 'EJ':
            emit('A', task.token, str(task.size))
            with open(task.path + '/out', 'rb') as f:
                if task.size > task.budget:
                    half = (task.budget + 1) // 2
                    emit('O', task.token, b64(f.read(half)))
                    f.seek(task.size - (task.budget - half))
                    emit('Z', task.token, b64(f.read(task.budget - half)))
                else:
                    emit('O', task.token, b64(f.read()))
            for name in ('cmd', 'pwd'):
                try:
                    os.unlink(task.path + '/' + name)
                except FileNotFoundError:
                    pass
            self.history.append((time.monotonic(), task.path))
            self.evict()
        else:
            if task.mode != 'F':
                with open(task.path + '/out', 'rb') as f:
                    emit('O', task.token, b64(f.read()))
            shutil.rmtree(task.path)
        code = task.proc.returncode
        emit('D', task.token, str(code if code >= 0 else 128 - code))
        self.active = None

    def handle(self, line):
        parts = line.rsplit('|', 1)[-1].split(' ')
        if len(parts) < 2:
            return
        mode, token = parts[:2]
        if mode in ('C', 'F', 'E', 'J') and TOKEN.fullmatch(token):
            if self.active:
                emit('D', token, '75')
                return
            retained = mode in 'EJ'
            budget = int(parts[2]) if retained else LIMIT
            command = base64.b64decode(parts[3 if retained else 2], validate=True)
            timeout = int(parts[4 if retained else 3]) / 1000
            if not 1 <= budget <= 8388616 or len(command) > LIMIT or not 0 < timeout <= 86400:
                emit('D', token, '64')
                return
            if token.startswith('w') and command == b':':
                emit('D', token, '0')
                return
            self.evict()
            self.active = Task(mode, token, command, budget, timeout)
            self.selector.register(self.active.proc.stdout, selectors.EVENT_READ, 'output')
            emit('T', token)
        elif mode == 'X' and self.active and token == self.active.token:
            self.interrupt()
        elif mode == 'N':
            self.evict()
            emit('D', token, '0')
        elif mode == 'B' and len(parts) == 5 and re.fullmatch(r'r[0-9]+', token):
            target, offset, count = parts[2], int(parts[3]), int(parts[4])
            if not re.fullmatch(r'e[0-9]+', target) or not 0 <= offset <= 9007199254740991 or not 1 <= count <= 65536:
                emit('D', token, '64')
                return
            try:
                with open(os.path.join(ROOT, target, 'out'), 'rb') as f:
                    size = os.fstat(f.fileno()).st_size
                    f.seek(offset)
                    data = f.read(count + 1)
            except FileNotFoundError:
                emit('D', token, '66')
                return
            emit('O', token, b64(('%s\n%s' % (size, b64(data))).encode('ascii')))
            emit('D', token, '0')

    def run(self):
        emit('H', '-', b64(ROOT.encode()))
        while True:
            self.reap()
            now = time.monotonic()
            for pid, deadline in list(self.orphans.items()):
                if now >= deadline:
                    kill_group(pid, signal.SIGKILL)
                    del self.orphans[pid]
            task = self.active
            if task:
                if not task.cancelled and now >= task.deadline:
                    self.interrupt(timed_out=True)
                if task.kill_at is not None and now >= task.kill_at:
                    kill_group(task.proc.pid, signal.SIGKILL)
                    task.kill_at = None
                if task.proc.returncode is not None and task.kill_at is None:
                    self.finish()
                    task = None
                elif task:
                    task.notify(now)
            deadlines = list(self.orphans.values())
            if task:
                if task.kill_at is not None:
                    deadlines.append(task.kill_at)
                elif not task.cancelled:
                    deadlines.append(task.deadline)
                if task.mode == 'J' and task.size != task.notified:
                    deadlines.append(task.notify_at)
            timeout = max(0, min(deadlines) - time.monotonic()) if deadlines else None
            for key, _ in self.selector.select(timeout):
                if key.data == 'input':
                    data = os.read(0, 65536)
                    if not data:
                        return
                    self.buffer.extend(data)
                    if len(self.buffer) > 4 * LIMIT:
                        raise ValueError('protocol input exceeds limit')
                    while b'\n' in self.buffer:
                        line, _, self.buffer = self.buffer.partition(b'\n')
                        self.handle(line.decode('ascii'))
                elif key.data == 'signal':
                    os.read(self.wake_read, 65536)
                elif self.active:
                    try:
                        data = os.read(key.fd, 32768)
                    except BlockingIOError:
                        continue
                    if data:
                        self.active.collect(data)
                    else:
                        self.selector.unregister(key.fileobj)

    def close(self):
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        pids = list(self.orphans)
        if self.active:
            pids.append(self.active.proc.pid)
        for pid in pids:
            kill_group(pid, signal.SIGTERM)
        if pids:
            time.sleep(.2)
        for pid in pids:
            kill_group(pid, signal.SIGKILL)
        if self.active:
            self.active.proc.wait()
            self.active.proc.stdout.close()
            self.active.out.close()
        for pid in pids:
            while True:
                try:
                    os.waitpid(-pid, 0)
                except ChildProcessError:
                    break
        self.reap()
        signal.set_wakeup_fd(-1)
        self.selector.close()
        os.close(self.wake_read)
        os.close(self.wake_write)


if __name__ == '__main__':
    controller = Controller()
    try:
        controller.run()
    finally:
        controller.close()

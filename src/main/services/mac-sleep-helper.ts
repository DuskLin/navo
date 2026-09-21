// The privileged shell is supplied literally to macOS authorization, never loaded
// from a user-writable script. Its only input is a short, expiring 0/1 lease.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export const macSleepSupervisor = String.raw`
session=$1
owner=$2
pmset=$3
owned=0
failed=0
expires=0
wanted=0
last=unknown
read_sleep() {
  output=$("$pmset" -g) || return 1
  /usr/bin/printf '%s\n' "$output" | /usr/bin/awk '$1 == "SleepDisabled" { print $2; found=1; exit } END { if (!found) print 0 }'
}
status() {
  /usr/bin/printf '%s\n' "$1" > "$session/status.next"
  /bin/mv -f "$session/status.next" "$session/status"
}
release() {
  if [ "$owned" = 1 ]; then
    "$pmset" -a disablesleep 0 && [ "$(read_sleep)" = 0 ] || return 1
    owned=0
  fi
}
cleanup() {
  trap '' HUP INT TERM
  # Retry restoration before exiting; a failed restore stays visible to the app.
  tries=0
  until release; do
    status restore-error
    tries=$((tries + 1))
    [ "$tries" -lt 10 ] || exit 1
    /bin/sleep 1
  done
  if [ "$failed" = 0 ]; then status stopped; fi
  /bin/sleep 2
  /bin/rm -rf "$session"
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM
status ready
while /bin/kill -0 "$owner" 2>/dev/null; do
  next_expires= next_wanted= extra=
  read -r next_expires next_wanted extra < "$session/control" || true
  # A write can briefly expose an empty file. Keep the last valid lease until
  # its deadline, rather than extending it or dropping an active assertion.
  case "$next_expires" in
    ''|*[!0-9]*|???????????*) ;;
    *)
      if [ -z "$extra" ]; then
        case "$next_wanted" in 0|1) expires=$next_expires; wanted=$next_wanted ;; esac
      fi
      ;;
  esac
  now=$(/bin/date +%s)
  [ "$expires" -gt "$now" ] && [ "$expires" -le "$((now + 15))" ] || break
  if [ "$wanted" != "$last" ]; then
    if [ "$wanted" = 1 ]; then
      current=$(read_sleep)
      case "$current" in
        0)
          owned=1
          if ! "$pmset" -a disablesleep 1 || [ "$(read_sleep)" != 1 ]; then
            failed=1; status enable-error; exit 1
          fi
          status active
          ;;
        1) status external ;;
        *) failed=1; status read-error; exit 1 ;;
      esac
    else
      if ! release; then failed=1; status restore-error; exit 1; fi
      if [ "$(read_sleep)" = 1 ]; then status external; else status ready; fi
    fi
    last=$wanted
  fi
  /bin/sleep 0.25
done
`

/** pmsetPath is injectable for unprivileged tests; production always uses Apple's binary. */
export function macSleepLaunchScript(
  pid: number,
  uid: number,
  pmsetPath = '/usr/bin/pmset'
): string {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('系统休眠辅助进程参数无效')
  }
  return `set -eu
umask 022
cd /
# macOS nohup tries to detach root processes from a console and fails with
# ENOTTY in Authorization Services. Inherit ignored SIGHUP instead of nohup.
# -p preserves the authorized effective UID in the nested shell.
trap '' HUP
session=$(/usr/bin/mktemp -d /private/tmp/navo-sleep.XXXXXXXX)
/bin/chmod 755 "$session"
/usr/bin/printf '%s 0\\n' "$(( $(/bin/date +%s) + 15 ))" > "$session/control"
/usr/sbin/chown ${uid} "$session/control"
/bin/chmod 600 "$session/control"
/bin/sh -p -c ${shellQuote(macSleepSupervisor)} navo-sleep "$session" ${pid} ${shellQuote(pmsetPath)} </dev/null >"$session/helper.log" 2>&1 &
helper=$!
attempt=0
while [ ! -s "$session/status" ]; do
  if ! /bin/kill -0 "$helper" 2>/dev/null || [ "$attempt" -ge 50 ]; then
    /usr/bin/printf '0 0\\n' > "$session/control"
    /usr/bin/printf 'Sleep helper failed to start: ' >&2
    /bin/cat "$session/helper.log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  /bin/sleep 0.1
done
/usr/bin/printf '%s\\n' "$session"
`
}

export function macSleepAuthorizationScript(pid: number, uid: number): string {
  const command = macSleepLaunchScript(pid, uid)
  const literal = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  return `do shell script "${literal}" with administrator privileges with prompt "Navo 需要在请求期间禁用系统睡眠（包括合盖），结束后自动恢复。屏幕仍可休眠。"`
}

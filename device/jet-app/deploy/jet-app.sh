#!/bin/sh
# On-device control: /opt/jet-app/deploy/jet-app.sh start|stop|restart|status
# Logs (JSON lines) go to /tmp/jet-app.log; the pid file is /tmp/jet-app.pid.
APP=/opt/jet-app; LOG=/tmp/jet-app.log; PID=/tmp/jet-app.pid
pid() { [ -f $PID ] && kill -0 "$(cat $PID)" 2>/dev/null && cat $PID; }
case "$1" in
  start)
    [ -n "$(pid)" ] && { echo "already running pid $(pid)"; exit 0; }
    [ -f /android-data/mainline/jet-app.env ] && . /android-data/mainline/jet-app.env
    # a wrapper waits on node and logs how it ended: a death by signal (status > 128) prints
    # nothing of its own, and that has happened (SIGSEGV, several times). Such a death is
    # restarted - the glasses must not sit dead until someone has ssh - unless `stop` asked for it
    # (the pid file is gone) or it keeps dying at once (five deaths, each within 30 s of its start).
    setsid nohup sh -c "
      quick=0
      while :; do
        t0=\$(date +%s)
        node $APP/src/main.js >> $LOG 2>&1 & echo \$! > $PID; wait \$!; s=\$?
        echo \"{\\\"t\\\":\\\"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\\\",\\\"level\\\":\\\"warn\\\",\\\"name\\\":\\\"jet-app.sh\\\",\\\"msg\\\":\\\"node exited\\\",\\\"status\\\":\$s}\" >> $LOG
        [ -f $PID ] || break                 # stopped on purpose
        [ \$s -gt 128 ] || break             # a clean exit or an error exit is not retried
        if [ \$((\$(date +%s) - t0)) -lt 30 ]; then quick=\$((quick + 1)); else quick=0; fi
        [ \$quick -ge 5 ] && break
        sleep 2
      done" >/dev/null 2>&1 &
    sleep 2; echo "started pid $(pid)"; tail -3 $LOG ;;
  stop)   p=$(pid); rm -f $PID; [ -n "$p" ] && kill "$p" && echo "stopped $p" ;;   # the pid file goes first: its absence tells the wrapper not to restart
  restart) $0 stop; sleep 1; $0 start ;;
  status) p=$(pid); [ -n "$p" ] && { echo "running pid $p"; grep VmRSS /proc/$p/status; } || echo "not running"; tail -3 $LOG 2>/dev/null ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1 ;;
esac

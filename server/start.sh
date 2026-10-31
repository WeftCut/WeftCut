#!/bin/sh
set -eu
export HOME=/data/home XDG_CONFIG_HOME=/data/settings XDG_RUNTIME_DIR=/data/run DISPLAY=:91
export PULSE_SERVER=unix:/data/run/pulse/native
export WEFTCUT_SERVER=1
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR" /data/projects /data/media /data/exports
chmod 700 "$XDG_RUNTIME_DIR"
python3 /opt/editor/server/bootstrap.py
cleanup() { trap - TERM INT EXIT; kill $(jobs -p) 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup TERM INT EXIT
Xtigervnc :91 -geometry 1920x1080 -depth 24 -rfbport 5901 -localhost -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize=1 -FrameRate 30 -nolisten tcp &
pulseaudio --exit-idle-time=-1 --daemonize=no --log-target=stderr --use-pid-file=no &
i=0
while ! pactl info >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 100 ] || exit 1; sleep .1; done
pactl load-module module-null-sink sink_name=editor >/dev/null
pactl set-default-sink editor
python3 -m websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901 &
python3 /opt/editor/server/gateway.py &
python3 /opt/editor/server/gpu_launch.py &
editor_pid=$!
wait "$editor_pid"

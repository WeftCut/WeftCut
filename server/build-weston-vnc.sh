#!/bin/sh
# Build the pinned remote compositor without replacing host GPU drivers.
set -eu
task_build=$(mktemp -d /tmp/weftcut-weston16.XXXXXX)
task_prefix=${WEFTCUT_WESTON_PREFIX:-/opt/weston16-vnc}
task_jobs=${WEFTCUT_BUILD_JOBS:-4}
cd "$task_build"
curl -fsSL https://gitlab.freedesktop.org/wayland/weston/-/releases/16.0.1/downloads/weston-16.0.1.tar.xz -o weston.tar.xz
printf '%s  %s\n' 54f889d236d73f497e7929f355ad87f03c2bbcde945bb29fbbae2a4b3050e467 weston.tar.xz | sha256sum -c -
mkdir weston
tar -xf weston.tar.xz -C weston --strip-components=1
curl -fsSL https://gitlab.freedesktop.org/wayland/wayland-protocols/-/releases/1.46/downloads/wayland-protocols-1.46.tar.xz -o protocols.tar.xz
printf '%s  %s\n' fd0de056a895fa48bd1aa5f0b8dfeed454101b88bc7e1c61a953422eb71db167 protocols.tar.xz | sha256sum -c -
mkdir protocols
tar -xf protocols.tar.xz -C protocols --strip-components=1
meson setup protocols-build protocols --prefix="$task_prefix" -Dtests=false
ninja -C protocols-build -j "$task_jobs" install
git clone --depth 1 --branch v1.0.3 https://github.com/any1/neatvnc.git weston/subprojects/neatvnc
test "$(git -C weston/subprojects/neatvnc rev-parse HEAD)" = 783437adc56c2d7ce2cac1ec584acad798594267
patch -d weston -p1 < "${WEFTCUT_WESTON_PATCH:?Set the absolute path to weston-16.0.1-shared-vnc-seat.patch}"
export PKG_CONFIG_PATH="$task_prefix/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
meson setup build weston --prefix="$task_prefix" -Drenderer-vulkan=false -Dshell-lua=false \
 -Dbackend-vnc=true -Dbackend-drm=false -Dbackend-pipewire=false -Dbackend-rdp=false \
 -Dbackend-x11=false -Dbackend-wayland=false -Dbackend-default=headless -Dxwayland=false \
 -Dsystemd=false -Dtests=false -Ddemo-clients=false -Dsimple-clients=[] -Dtools=[] \
 -Dimage-webp=false -Dshell-ivi=false
test "$(git -C weston/subprojects/aml rev-parse HEAD)" = 685035c9830aa89df02a43df89b644690bd885f5
ninja -C build -j "$task_jobs"
ninja -C build install
printf 'Built Weston 16.0.1 + NeatVNC 1.0.3 in %s; sources: %s\n' "$task_prefix" "$task_build"

#!/usr/bin/python3
"""Narrow compatibility fix for v0.5.4's odd-height full-proxy filter.

The verified release native addon invokes FFmpeg itself. Keep its ABI and all
commands intact, adding an even pad only to the affected proxy filter. Builds
using corrected Rust stop matching automatically; no shell interpretation.
"""
import os
import re
import sys

REAL = '/opt/WeftCut/resources/ffmpeg/ffmpeg.native'
PROXY = re.compile(r"scale=-2:'min\(ih,[1-9][0-9]*\)'")


def proxy_args(args):
    result = list(args)
    if not any(result[i:i + 2] == ['-c:v', 'libx264'] for i in range(len(result) - 1)):
        return result
    for i in range(len(result) - 1):
        if result[i] == '-vf' and PROXY.fullmatch(result[i + 1]):
            result[i + 1] += ',pad=ceil(iw/2)*2:ceil(ih/2)*2'
    return result


def vaapi_args(args, device):
    """Supply the pinned render device and upload CPU frames for VAAPI only.

    The release native encoder passes CPU frames and setparams, but its VAAPI
    adapter omitted hwupload. NVENC, software codecs and explicit HW graphs
    must remain byte-for-byte unchanged.
    """
    result = list(args)
    if not device or not re.fullmatch(r'/dev/dri/renderD[0-9]+', device):
        return result
    if not any(result[i:i + 2] in (['-c:v', 'h264_vaapi'], ['-c:v', 'hevc_vaapi'], ['-c:v', 'av1_vaapi']) for i in range(len(result) - 1)):
        return result
    if '-vaapi_device' in result or '-init_hw_device' in result or '-filter_complex' in result:
        return result
    if any('hwupload' in result[i + 1] for i in range(len(result) - 1) if result[i] in ('-vf', '-filter:v')):
        return result
    pixel_format = 'p010le' if any(p in result for p in ('p010le', 'yuv420p10le')) else 'nv12'
    upload = f'format={pixel_format},hwupload'
    for i in range(len(result) - 1):
        if result[i] in ('-vf', '-filter:v'):
            result[i + 1] += ',' + upload
            break
    else:
        # Output options must precede the output destination, including '-'.
        result[-1:-1] = ['-vf', upload]
    return ['-vaapi_device', device, *result]


if __name__ == '__main__':
    device = os.environ.get('WEFTCUT_VAAPI_DEVICE')
    os.execv(REAL, [REAL, *vaapi_args(proxy_args(sys.argv[1:]), device)])

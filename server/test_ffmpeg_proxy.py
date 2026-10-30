import unittest
from ffmpeg_proxy import proxy_args, vaapi_args


class ProxyArgsTests(unittest.TestCase):
    def test_vaapi_upload_keeps_color_filter_and_selected_device(self):
        args = ['-i', 'pipe:0', '-vf', 'setparams=range=limited', '-c:v', 'h264_vaapi', '-pix_fmt', 'nv12', '-f', 'null', '-']
        fixed = vaapi_args(args, '/dev/dri/renderD129')
        self.assertEqual(fixed[:2], ['-vaapi_device', '/dev/dri/renderD129'])
        self.assertIn('setparams=range=limited,format=nv12,hwupload', fixed)
        self.assertEqual(vaapi_args(fixed, '/dev/dri/renderD129'), fixed)
        self.assertNotIn('hwupload', ','.join(args))

    def test_vaapi_10bit_and_unfiltered_cpu_frames(self):
        args = ['-i', 'pipe:0', '-c:v', 'hevc_vaapi', '-pix_fmt', 'p010le', '-f', 'null', '-']
        fixed = vaapi_args(args, '/dev/dri/renderD129')
        self.assertEqual(fixed[-3:], ['-vf', 'format=p010le,hwupload', '-'])
        av1 = vaapi_args(['-i', 'pipe:0', '-c:v', 'av1_vaapi', '-pix_fmt', 'p010le', '-'], '/dev/dri/renderD129')
        self.assertIn('format=p010le,hwupload', av1)

    def test_vaapi_does_not_change_nvenc_or_explicit_graphs(self):
        for args in (['-c:v', 'h264_nvenc', 'a.mp4'], ['-c:v', 'libx264', 'a.mp4'],
                     ['-init_hw_device', 'vaapi=custom', '-c:v', 'h264_vaapi', 'a.mp4'],
                     ['-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', 'a.mp4']):
            self.assertEqual(vaapi_args(args, '/dev/dri/renderD129'), args)
        self.assertEqual(vaapi_args(['-c:v', 'h264_vaapi', '-'], '../../device'), ['-c:v', 'h264_vaapi', '-'])
    def test_pad_only_affected_proxy(self):
        args = ['-i', '/data/clip odd.webm', '-vf', "scale=-2:'min(ih,1440)'", '-c:v', 'libx264', '/data/proxy.tmp.mp4']
        fixed = proxy_args(args)
        self.assertEqual(args[3], "scale=-2:'min(ih,1440)'")
        self.assertEqual(fixed[3], args[3] + ',pad=ceil(iw/2)*2:ceil(ih/2)*2')
        self.assertEqual(fixed[1], args[1])
        self.assertEqual(proxy_args(fixed), fixed)

    def test_probe_audio_quick_proxy_and_exports_unchanged(self):
        for args in (['-version'], ['-i', 'a.wav', '-c:a', 'aac', 'out.m4a'],
                     ['-vf', 'scale=-2:360', '-c:v', 'libx264', 'quick.mp4'],
                     ['-vf', 'scale=1920:1080', '-c:v', 'libx264', 'final.mp4'],
                     ['-vf', "scale=-2:'min(ih,1440)'", '-frames:v', '1', 'image.png']):
            self.assertEqual(proxy_args(args), args)


if __name__ == '__main__':
    unittest.main()

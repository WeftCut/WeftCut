// Decode and hash every video frame; separately hash AAC payloads and timing.
// A measurement tool, never rewrites a source or substitutes for visual review.
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libavutil/md5.h>
}
#include <nlohmann/json.hpp>
#include <cstdio>
#include <iostream>
#include <stdexcept>
#include <vector>
static void check(int n) { if (n<0) { char e[AV_ERROR_MAX_STRING_SIZE]; av_strerror(n,e,sizeof e); throw std::runtime_error(e); } }
static std::string finish(AVMD5* md5) { unsigned char sum[16]; av_md5_final(md5,sum); av_free(md5); char text[33]; for (int i=0;i<16;i++) snprintf(text+i*2,3,"%02x",sum[i]); return text; }
int main(int argc,char** argv) {
  try {
    if (argc!=2) throw std::runtime_error("Usage: verify-video input.mp4");
    AVFormatContext* in=nullptr; check(avformat_open_input(&in,argv[1],nullptr,nullptr)); check(avformat_find_stream_info(in,nullptr));
    int index=av_find_best_stream(in,AVMEDIA_TYPE_VIDEO,-1,-1,nullptr,0); check(index);
    const AVCodec* codec=avcodec_find_decoder(in->streams[index]->codecpar->codec_id);
    AVCodecContext* decoder=avcodec_alloc_context3(codec); check(avcodec_parameters_to_context(decoder,in->streams[index]->codecpar));
    decoder->thread_count=4; check(avcodec_open2(decoder,codec,nullptr));
    AVFrame* frame=av_frame_alloc(); AVPacket* packet=av_packet_alloc();
    auto *video=av_md5_alloc(), *audio=av_md5_alloc(), *timing=av_md5_alloc(); av_md5_init(video); av_md5_init(audio); av_md5_init(timing);
    std::vector<unsigned char> pixels; int frames=0, audioPackets=0; int64_t last=AV_NOPTS_VALUE;
    auto receive=[&]() {
      for (;;) {
        int result=avcodec_receive_frame(decoder,frame); if (result==AVERROR(EAGAIN)||result==AVERROR_EOF) break; check(result);
        int size=av_image_get_buffer_size((AVPixelFormat)frame->format,frame->width,frame->height,1); check(size); pixels.resize(size);
        check(av_image_copy_to_buffer(pixels.data(),size,frame->data,frame->linesize,(AVPixelFormat)frame->format,frame->width,frame->height,1));
        av_md5_update(video,pixels.data(),size);
        const int64_t pts=av_rescale_q(frame->best_effort_timestamp,in->streams[index]->time_base,AV_TIME_BASE_Q);
        if (pts==AV_NOPTS_VALUE || (last!=AV_NOPTS_VALUE && pts<=last)) throw std::runtime_error("Invalid video timestamp order");
        av_md5_update(timing,(unsigned char*)&pts,sizeof pts); last=pts; ++frames; av_frame_unref(frame);
      }
    };
    for (;;) {
      int result=av_read_frame(in,packet); if (result==AVERROR_EOF) break; check(result);
      if (packet->stream_index==index) { check(avcodec_send_packet(decoder,packet)); receive(); }
      else if (in->streams[packet->stream_index]->codecpar->codec_type==AVMEDIA_TYPE_AUDIO) {
        av_md5_update(audio,packet->data,packet->size); ++audioPackets;
      }
      av_packet_unref(packet);
    }
    check(avcodec_send_packet(decoder,nullptr)); receive();
    std::cout << nlohmann::json({{"frames",frames},{"decoded_video_md5",finish(video)},{"video_pts_md5",finish(timing)},
      {"audio_payload_md5",finish(audio)},{"audio_packets",audioPackets},{"duration_us",in->duration},
      {"width",decoder->width},{"height",decoder->height}}).dump() << std::endl;
    av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&decoder); avformat_close_input(&in); return 0;
  } catch(const std::exception& error) { fprintf(stderr,"VERIFY_FAILED: %s\n",error.what()); return 1; }
}

// Experimental standalone export lane. Not selected by the editor.
// libav APIs, not an ffmpeg command wrapper. Source media is read-only.
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersrc.h>
#include <libavfilter/buffersink.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libavutil/display.h>
}
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <fstream>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include <unistd.h>
#include <fcntl.h>

using json = nlohmann::json;
static volatile std::sig_atomic_t cancelled = 0;
static void stop(int) { cancelled = 1; }
static double clockMs() { return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
static void check(int result, const char* stage) {
  if (result < 0) { char error[AV_ERROR_MAX_STRING_SIZE]; av_strerror(result,error,sizeof error); throw std::runtime_error(std::string(stage)+": "+error); }
}
static AVPixelFormat cudaFormat(AVCodecContext*, const AVPixelFormat* formats) {
  for (; *formats != AV_PIX_FMT_NONE; ++formats) if (*formats == AV_PIX_FMT_CUDA) return *formats;
  return AV_PIX_FMT_NONE; // Never silently measure software decoding as hardware.
}
struct Resources {
  AVFormatContext *in=nullptr, *out=nullptr;
  AVCodecContext *decoder=nullptr, *encoder=nullptr;
  AVBufferRef* device=nullptr;
  AVFilterGraph* graph=nullptr;
  AVFrame *frame=av_frame_alloc(), *filtered=av_frame_alloc(), *host=av_frame_alloc(), *upload=av_frame_alloc();
  AVPacket *packet=av_packet_alloc(), *encoded=av_packet_alloc();
  std::vector<AVPacket*> audioPrefix;
  std::string partial;
  ~Resources() {
    for (auto* p:audioPrefix) av_packet_free(&p);
    av_packet_free(&packet); av_packet_free(&encoded);
    av_frame_free(&frame); av_frame_free(&filtered); av_frame_free(&host); av_frame_free(&upload);
    avcodec_free_context(&encoder); avcodec_free_context(&decoder); avfilter_graph_free(&graph);
    av_buffer_unref(&device); avformat_close_input(&in);
    if (out) { if (out->pb) avio_closep(&out->pb); avformat_free_context(out); }
    if (!partial.empty()) unlink(partial.c_str());
  }
};

int main(int argc, char** argv) {
  av_log_set_level(AV_LOG_WARNING);
  std::signal(SIGTERM,stop); std::signal(SIGINT,stop);
  Resources r;
  try {
    if (argc != 2) throw std::runtime_error("Usage: video-worker job.json");
    std::ifstream file(argv[1]); json job=json::parse(file);
    const std::vector<std::string> fields={"source","output","mode","codec","width","height","frames","fps_num","fps_den","start_us","copy_audio"};
    for (const auto& item:job.items()) if (std::find(fields.begin(),fields.end(),item.key())==fields.end())
      throw std::runtime_error("Unsupported job field: "+item.key()+"; no requested effects may be silently dropped");
    const std::string source=job.at("source"), output=job.at("output"), mode=job.at("mode"), codec=job.at("codec");
    if (!std::filesystem::path(source).is_absolute() || !std::filesystem::is_regular_file(source) || !std::filesystem::path(output).is_absolute())
      throw std::runtime_error("Local source file and absolute output path required");
    const int w=job.at("width"), h=job.at("height"), count=job.at("frames"), num=job.at("fps_num"), den=job.at("fps_den");
    const bool copyAudio=job.value("copy_audio",false), roundtrip=mode=="cpu-roundtrip";
    if (mode!="gpu" && !roundtrip) throw std::runtime_error("Unknown mode");
    if (codec!="h264" && codec!="hevc") throw std::runtime_error("Unsupported codec");
    if (w<16 || h<16 || w>4096 || h>4096 || w%2 || h%2 || count<1 || count>1800 || num<1 || num>120000 || den<1 || den>1001)
      throw std::runtime_error("Invalid bounded export dimensions/timebase");
    if (job.value("start_us",0)!=0) throw std::runtime_error("Prototype accepts source time zero only; editor must retain its current lane for trims");
    const double start=clockMs();
    check(avformat_open_input(&r.in,source.c_str(),nullptr,nullptr),"open source");
    check(avformat_find_stream_info(r.in,nullptr),"source metadata");
    const int video=av_find_best_stream(r.in,AVMEDIA_TYPE_VIDEO,-1,-1,nullptr,0);
    check(video,"video stream");
    AVStream* input=r.in->streams[video];
    if (input->start_time!=AV_NOPTS_VALUE && input->start_time!=0)
      throw std::runtime_error("Nonzero source video origin requires the editor lane");
    if (av_cmp_q(input->avg_frame_rate,{num,den})!=0)
      throw std::runtime_error("Frame-rate conversion is not yet qualified; retain the editor lane");
    if (input->codecpar->color_space!=AVCOL_SPC_BT709 || input->codecpar->color_range!=AVCOL_RANGE_MPEG ||
        input->codecpar->color_trc!=AVCOL_TRC_BT709 || input->codecpar->color_primaries!=AVCOL_PRI_BT709)
      throw std::runtime_error("Prototype requires explicitly tagged BT.709 limited SDR; no implicit color conversion");
    if (input->sample_aspect_ratio.num && av_cmp_q(input->sample_aspect_ratio,{1,1})!=0)
      throw std::runtime_error("Non-square source pixels require the editor lane");
    size_t matrixSize=0;
    const auto* matrix=(const int32_t*)av_stream_get_side_data(input,AV_PKT_DATA_DISPLAYMATRIX,&matrixSize);
    const int32_t identity[9]={65536,0,0,0,65536,0,0,0,1073741824};
    if (matrix && (matrixSize!=sizeof identity || memcmp(matrix,identity,sizeof identity)!=0))
      throw std::runtime_error("Source display transform requires the editor lane, rotation="+std::to_string(av_display_rotation_get(matrix)));
    check(av_hwdevice_ctx_create(&r.device,AV_HWDEVICE_TYPE_CUDA,"0",nullptr,0),"CUDA device");
    r.decoder=avcodec_alloc_context3(avcodec_find_decoder(input->codecpar->codec_id));
    if (!r.decoder) throw std::runtime_error("Decoder unavailable");
    check(avcodec_parameters_to_context(r.decoder,input->codecpar),"decoder parameters");
    r.decoder->hw_device_ctx=av_buffer_ref(r.device); r.decoder->get_format=cudaFormat;
    r.decoder->thread_count=1; // Native NVDEC lane, not a CPU rendering limit.
    check(avcodec_open2(r.decoder,r.decoder->codec,nullptr),"open hardware decoder");

    // Reserve an exclusive task-owned staging file; publication never replaces a file.
    const std::string staging=output+".partial-"+std::to_string(getpid());
    int fd=open(staging.c_str(),O_CREAT|O_EXCL|O_WRONLY,0600);
    if (fd<0) throw std::runtime_error("Cannot reserve export staging file");
    r.partial=staging; // Cleanup owns only the file this process actually created.
    close(fd);
    check(avformat_alloc_output_context2(&r.out,nullptr,"mp4",r.partial.c_str()),"MP4 muxer");
    AVStream* dstVideo=avformat_new_stream(r.out,nullptr);
    if (!dstVideo) throw std::runtime_error("Output video stream allocation");
    int audio=-1; AVStream* dstAudio=nullptr;
    if (copyAudio) {
      audio=av_find_best_stream(r.in,AVMEDIA_TYPE_AUDIO,-1,-1,nullptr,0);
      check(audio,"requested audio stream");
      if (r.in->streams[audio]->codecpar->codec_id!=AV_CODEC_ID_AAC) throw std::runtime_error("Prototype audio remux supports AAC only; other mixes retain the editor lane");
      dstAudio=avformat_new_stream(r.out,nullptr);
      if (!dstAudio) throw std::runtime_error("Output audio stream allocation");
      check(avcodec_parameters_copy(dstAudio->codecpar,r.in->streams[audio]->codecpar),"audio parameters");
      dstAudio->codecpar->codec_tag=0; dstAudio->time_base=r.in->streams[audio]->time_base;
    }
    AVFilterContext *src=nullptr,*sink=nullptr;
    bool header=false, videoDone=false, audioDone=!copyAudio;
    int frames=0; int64_t cpuBytes=0, first=AV_NOPTS_VALUE, previous=AV_NOPTS_VALUE;
    double transferMs=0, filterMs=0, encodeMs=0;
    const AVRational timebase={den,num};
    const int64_t durationUs=av_rescale_q(count,timebase,AV_TIME_BASE_Q);
    auto muxAudio=[&](AVPacket* packet) {
      const AVRational audioTime=r.in->streams[audio]->time_base;
      if (packet->pts==AV_NOPTS_VALUE) throw std::runtime_error("Missing audio timestamps");
      if (av_compare_ts(packet->pts,audioTime,durationUs,AV_TIME_BASE_Q)>=0) audioDone=true;
      else {
        // MP4's final AAC sample duration trims packet padding, without touching
        // the compressed payload. Preserve the initial priming/edit list.
        const int64_t end=av_rescale_q(durationUs,AV_TIME_BASE_Q,audioTime);
        if (packet->duration>0 && packet->pts+packet->duration>end) packet->duration=end-packet->pts;
        av_packet_rescale_ts(packet,audioTime,dstAudio->time_base); packet->stream_index=dstAudio->index;
        check(av_interleaved_write_frame(r.out,packet),"mux source AAC");
      }
    };
    auto drainEncoder=[&]() {
      while (true) {
        const int result=avcodec_receive_packet(r.encoder,r.encoded);
        if (result==AVERROR(EAGAIN)||result==AVERROR_EOF) break;
        check(result,"receive encoded packet");
        if (!r.encoded->duration) r.encoded->duration=1;
        av_packet_rescale_ts(r.encoded,r.encoder->time_base,dstVideo->time_base);
        r.encoded->stream_index=dstVideo->index;
        check(av_interleaved_write_frame(r.out,r.encoded),"mux video"); av_packet_unref(r.encoded);
      }
    };
    auto consume=[&]() {
      while (!videoDone) {
        int result=avcodec_receive_frame(r.decoder,r.frame);
        if (result==AVERROR(EAGAIN)||result==AVERROR_EOF) break;
        check(result,"decode frame");
        if (cancelled) throw std::runtime_error("Export cancelled");
        if (r.frame->format!=AV_PIX_FMT_CUDA || !r.frame->hw_frames_ctx) throw std::runtime_error("Decoder did not return a CUDA frame");
        const auto* hw=(const AVHWFramesContext*)r.frame->hw_frames_ctx->data;
        if (hw->sw_format!=AV_PIX_FMT_NV12) throw std::runtime_error("Prototype accepts NV12 8-bit only; 10-bit source retains the editor lane");
        const int64_t pts=r.frame->best_effort_timestamp;
        if (pts==AV_NOPTS_VALUE) throw std::runtime_error("Missing source timestamps");
        if (first==AV_NOPTS_VALUE) first=pts;
        if (previous!=AV_NOPTS_VALUE && pts<=previous) throw std::runtime_error("Non-monotonic source timestamps");
        previous=pts;
        if (av_compare_ts(pts-first,input->time_base,frames,timebase)<0) { av_frame_unref(r.frame); continue; }
        if (!header) {
          r.graph=avfilter_graph_alloc();
          r.graph->nb_threads=1; // CUDA scaling; no CPU frame filter workers.
          src=avfilter_graph_alloc_filter(r.graph,avfilter_get_by_name("buffer"),"source");
          sink=avfilter_graph_alloc_filter(r.graph,avfilter_get_by_name("buffersink"),"sink");
          if (!src||!sink) throw std::runtime_error("Buffer filters unavailable");
          AVBufferSrcParameters* params=av_buffersrc_parameters_alloc();
          params->format=AV_PIX_FMT_CUDA; params->width=r.frame->width; params->height=r.frame->height;
          params->time_base=timebase; params->sample_aspect_ratio={1,1}; params->hw_frames_ctx=r.frame->hw_frames_ctx;
          int p=av_buffersrc_parameters_set(src,params); av_free(params); check(p,"source CUDA parameters");
          check(avfilter_init_str(src,nullptr),"source filter"); check(avfilter_init_str(sink,nullptr),"sink filter");
          AVFilterContext* scale=nullptr;
          const std::string args="w="+std::to_string(w)+":h="+std::to_string(h)+":interp_algo=bicubic:passthrough=0";
          check(avfilter_graph_create_filter(&scale,avfilter_get_by_name("scale_cuda"),"scale",args.c_str(),nullptr,r.graph),"CUDA scale filter");
          check(avfilter_link(src,0,scale,0),"source link"); check(avfilter_link(scale,0,sink,0),"sink link");
          check(avfilter_graph_config(r.graph,nullptr),"CUDA filter graph");
          const AVCodec* enc=avcodec_find_encoder_by_name(codec=="hevc"?"hevc_nvenc":"h264_nvenc");
          if (!enc) throw std::runtime_error("NVENC unavailable");
          r.encoder=avcodec_alloc_context3(enc); r.encoder->width=w; r.encoder->height=h;
          r.encoder->pix_fmt=AV_PIX_FMT_CUDA; r.encoder->time_base=timebase; r.encoder->framerate={num,den};
          r.encoder->sample_aspect_ratio={1,1}; r.encoder->bit_rate=8000000; r.encoder->gop_size=num/den; r.encoder->max_b_frames=0;
          r.encoder->colorspace=AVCOL_SPC_BT709; r.encoder->color_range=AVCOL_RANGE_MPEG;
          r.encoder->color_primaries=AVCOL_PRI_BT709; r.encoder->color_trc=AVCOL_TRC_BT709;
          r.encoder->hw_frames_ctx=av_buffer_ref(av_buffersink_get_hw_frames_ctx(sink));
          if (r.out->oformat->flags&AVFMT_GLOBALHEADER) r.encoder->flags|=AV_CODEC_FLAG_GLOBAL_HEADER;
          check(av_opt_set(r.encoder->priv_data,"preset","p4",0),"NVENC preset");
          check(av_opt_set(r.encoder->priv_data,"rc","cbr",0),"NVENC rate control");
          check(avcodec_open2(r.encoder,enc,nullptr),"open NVENC");
          check(avcodec_parameters_from_context(dstVideo->codecpar,r.encoder),"video output parameters");
          dstVideo->time_base=timebase; dstVideo->avg_frame_rate={num,den};
          check(avio_open(&r.out->pb,r.partial.c_str(),AVIO_FLAG_WRITE),"open output");
          check(avformat_write_header(r.out,nullptr),"MP4 header"); header=true;
          for (auto*& packet:r.audioPrefix) { muxAudio(packet); av_packet_free(&packet); }
          r.audioPrefix.clear();
        }
        r.frame->pts=frames;
        double tick=clockMs();
        check(av_buffersrc_add_frame_flags(src,r.frame,AV_BUFFERSRC_FLAG_KEEP_REF),"feed GPU filter");
        check(av_buffersink_get_frame(sink,r.filtered),"read GPU filter"); filterMs+=clockMs()-tick;
        AVFrame* encodedFrame=r.filtered;
        if (roundtrip) {
          tick=clockMs();
          check(av_hwframe_transfer_data(r.host,r.filtered,0),"GPU to RAM control");
          check(av_hwframe_get_buffer(r.filtered->hw_frames_ctx,r.upload,0),"upload frame allocation");
          check(av_hwframe_transfer_data(r.upload,r.host,0),"RAM to GPU control");
          check(av_frame_copy_props(r.upload,r.filtered),"upload properties");
          encodedFrame=r.upload; cpuBytes+=int64_t(w)*h*3; transferMs+=clockMs()-tick;
        }
        tick=clockMs(); check(avcodec_send_frame(r.encoder,encodedFrame),"encode CUDA frame"); drainEncoder(); encodeMs+=clockMs()-tick;
        ++frames;
        if (frames%30==0) fprintf(stderr,"NATIVE_EXPORT_PROGRESS %d/%d\n",frames,count);
        av_frame_unref(r.frame); av_frame_unref(r.filtered); av_frame_unref(r.host); av_frame_unref(r.upload);
        videoDone=frames==count;
      }
    };
    while ((!videoDone || !audioDone) && !cancelled) {
      int result=av_read_frame(r.in,r.packet);
      if (result==AVERROR_EOF) break;
      check(result,"read source packet");
      if (r.packet->stream_index==video && !videoDone) { check(avcodec_send_packet(r.decoder,r.packet),"feed decoder"); consume(); }
      else if (r.packet->stream_index==audio && !audioDone) {
        if (header) muxAudio(r.packet);
        else {
          if (r.audioPrefix.size()>=256) throw std::runtime_error("Excess audio before first video frame");
          AVPacket* saved=av_packet_clone(r.packet); if (!saved) throw std::bad_alloc(); r.audioPrefix.push_back(saved);
        }
      }
      av_packet_unref(r.packet);
    }
    if (cancelled) throw std::runtime_error("Export cancelled");
    if (!videoDone) { check(avcodec_send_packet(r.decoder,nullptr),"flush decoder"); consume(); }
    if (frames!=count) throw std::runtime_error("Source ended before requested export frames");
    check(avcodec_send_frame(r.encoder,nullptr),"flush NVENC"); drainEncoder();
    check(av_write_trailer(r.out),"MP4 trailer"); check(avio_closep(&r.out->pb),"close MP4");
    // Atomic no-replace publication. A collision leaves the old output untouched.
    if (link(r.partial.c_str(),output.c_str())!=0) throw std::runtime_error("Output exists or publication failed; refusing overwrite");
    const double elapsed=clockMs()-start;
    std::cout << json({{"mode",mode},{"codec",codec},{"frames",frames},{"width",w},{"height",h},{"fps_num",num},{"fps_den",den},
      {"elapsed_ms",elapsed},{"throughput_fps",frames*1000/elapsed},{"filter_ms",filterMs},{"roundtrip_ms",transferMs},
      {"encode_mux_ms",encodeMs},{"cpu_raw_bytes",cpuBytes},{"audio",copyAudio?"AAC packet remux":"none"},
      {"output",output},{"experimental",true}}).dump() << std::endl;
    return 0;
  } catch (const std::exception& error) { fprintf(stderr,"NATIVE_EXPORT_FAILED: %s\n",error.what()); return cancelled?130:1; }
}

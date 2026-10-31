// Isolated feasibility benchmark, not the editor export implementation.
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <cuda.h>
#include <cudaEGL.h>
#include "nvEncodeAPI.h"
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <stdexcept>
#include <chrono>

static void cu(CUresult r,const char* stage){if(r!=CUDA_SUCCESS){const char* name=nullptr;cuGetErrorName(r,&name);throw std::runtime_error(std::string(stage)+": "+(name?name:"CUDA error"));}}
static void nv(NVENCSTATUS r,const char* stage){if(r!=NV_ENC_SUCCESS)throw std::runtime_error(std::string(stage)+": NVENC status "+std::to_string(r));}
static double now(){return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();}
int main(int argc,char**argv){
 try{
  const bool cpu=argc>1&&std::string(argv[1])=="cpu";
  const char* path=argc>2?argv[2]:"/tmp/weftcut-egl-native-gpu.h264";
  const std::string codec=argc>3?argv[3]:"h264";
  const bool hevc=codec=="hevc"||codec=="hevc10";
  const bool tenBit=codec=="hevc10";
  if(codec!="h264"&&!hevc)throw std::runtime_error("Choose h264, hevc or hevc10");
  const GUID codecGuid=hevc?NV_ENC_CODEC_HEVC_GUID:NV_ENC_CODEC_H264_GUID;
  const unsigned width=1920,height=1080,frames=120;
  cu(cuInit(0),"cuInit");
  CUdevice cudaDevice;cu(cuDeviceGet(&cudaDevice,0),"cuDeviceGet");
  CUcontext cudaContext;cu(cuCtxCreate(&cudaContext,0,cudaDevice),"cuCtxCreate");
  auto queryDevices=(PFNEGLQUERYDEVICESEXTPROC)eglGetProcAddress("eglQueryDevicesEXT");
  auto queryDeviceAttrib=(PFNEGLQUERYDEVICEATTRIBEXTPROC)eglGetProcAddress("eglQueryDeviceAttribEXT");
  auto platformDisplay=(PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDeviceEXT devices[16];EGLint count=0;EGLDisplay display=EGL_NO_DISPLAY;
  if(!queryDevices||!platformDisplay||!queryDeviceAttrib)throw std::runtime_error("EGL device extensions unavailable");
  queryDevices(16,devices,&count);
  for(int i=0;i<count;i++){EGLAttrib id=-1;if(queryDeviceAttrib(devices[i],0x323A,&id)&&id==0){display=platformDisplay(EGL_PLATFORM_DEVICE_EXT,devices[i],nullptr);break;}}
  if(display==EGL_NO_DISPLAY)throw std::runtime_error("No EGL device matching CUDA device 0");
  EGLint major,minor;if(!eglInitialize(display,&major,&minor))throw std::runtime_error("eglInitialize failed");
  if(!eglBindAPI(EGL_OPENGL_ES_API))throw std::runtime_error("eglBindAPI failed");
  const EGLint attrs[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
  EGLConfig config;EGLint configs=0;if(!eglChooseConfig(display,attrs,&config,1,&configs)||!configs)throw std::runtime_error("EGL config unavailable");
  const EGLint contextAttrs[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};
  const EGLint surfaceAttrs[]={EGL_WIDTH,1,EGL_HEIGHT,1,EGL_NONE};
  EGLContext context=eglCreateContext(display,config,EGL_NO_CONTEXT,contextAttrs);
  EGLSurface surface=eglCreatePbufferSurface(display,config,surfaceAttrs);
  if(context==EGL_NO_CONTEXT||surface==EGL_NO_SURFACE||!eglMakeCurrent(display,surface,surface,context))throw std::runtime_error("EGL context creation failed");
  const std::string renderer=(const char*)glGetString(GL_RENDERER);
  if(renderer.find("NVIDIA")==std::string::npos)throw std::runtime_error("Not using NVIDIA renderer: "+renderer);
  GLuint texture,fbo;glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);glTexStorage2D(GL_TEXTURE_2D,1,tenBit?GL_RGB10_A2:GL_RGBA8,width,height);
  glGenFramebuffers(1,&fbo);glBindFramebuffer(GL_FRAMEBUFFER,fbo);glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,texture,0);
  if(glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)throw std::runtime_error("Framebuffer incomplete");
  auto createImage=(PFNEGLCREATEIMAGEKHRPROC)eglGetProcAddress("eglCreateImageKHR");
  auto destroyImage=(PFNEGLDESTROYIMAGEKHRPROC)eglGetProcAddress("eglDestroyImageKHR");
  EGLint imageAttrs[]={EGL_GL_TEXTURE_LEVEL_KHR,0,EGL_NONE};
  EGLImageKHR image=createImage(display,context,EGL_GL_TEXTURE_2D_KHR,(EGLClientBuffer)(uintptr_t)texture,imageAttrs);
  if(image==EGL_NO_IMAGE_KHR)throw std::runtime_error("eglCreateImageKHR failed "+std::to_string(eglGetError()));
  CUgraphicsResource resource;cu(cuGraphicsEGLRegisterImage(&resource,image,CU_GRAPHICS_MAP_RESOURCE_FLAGS_READ_ONLY),"cuGraphicsEGLRegisterImage");
  CUeglFrame eglFrame;cu(cuGraphicsResourceGetMappedEglFrame(&eglFrame,resource,0,0),"cuGraphicsResourceGetMappedEglFrame");
  if(eglFrame.planeCount!=1||(!tenBit&&eglFrame.numChannels!=4))throw std::runtime_error("Unexpected EGL plane layout");
  if(eglFrame.frameType==CU_EGL_FRAME_TYPE_ARRAY){
   CUDA_ARRAY_DESCRIPTOR descriptor;cu(cuArrayGetDescriptor(&descriptor,eglFrame.frame.pArray[0]),"cuArrayGetDescriptor");
   const bool packedRgba=descriptor.NumChannels==4&&descriptor.Format==(tenBit?CU_AD_FORMAT_UNORM_INT_101010_2:CU_AD_FORMAT_UNSIGNED_INT8);
   if(descriptor.Width!=width||descriptor.Height!=height||!packedRgba)
    throw std::runtime_error("EGL packed layout mismatch: width="+std::to_string(descriptor.Width)+" height="+std::to_string(descriptor.Height)+" format="+std::to_string(descriptor.Format)+" channels="+std::to_string(descriptor.NumChannels));
  }
  void* library=dlopen("libnvidia-encode.so.1",RTLD_NOW);if(!library)throw std::runtime_error(dlerror());
  using CreateApi = NVENCSTATUS (NVENCAPI *)(NV_ENCODE_API_FUNCTION_LIST*);
  auto createApi=(CreateApi)dlsym(library,"NvEncodeAPICreateInstance");
  NV_ENCODE_API_FUNCTION_LIST api={NV_ENCODE_API_FUNCTION_LIST_VER};nv(createApi(&api),"NvEncodeAPICreateInstance");
  NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open={NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER};open.deviceType=NV_ENC_DEVICE_TYPE_CUDA;open.device=cudaContext;open.apiVersion=NVENCAPI_VERSION;
  void* encoder=nullptr;nv(api.nvEncOpenEncodeSessionEx(&open,&encoder),"nvEncOpenEncodeSessionEx");
  NV_ENC_PRESET_CONFIG preset={NV_ENC_PRESET_CONFIG_VER};preset.presetCfg.version=NV_ENC_CONFIG_VER;
  nv(api.nvEncGetEncodePresetConfigEx(encoder,codecGuid,NV_ENC_PRESET_P4_GUID,NV_ENC_TUNING_INFO_HIGH_QUALITY,&preset),"nvEncGetEncodePresetConfigEx");
  NV_ENC_CONFIG encConfig=preset.presetCfg;encConfig.gopLength=30;encConfig.frameIntervalP=1;
  encConfig.rcParams.rateControlMode=NV_ENC_PARAMS_RC_CBR;encConfig.rcParams.averageBitRate=8000000;encConfig.rcParams.maxBitRate=8000000;
  NV_ENC_CONFIG_H264_VUI_PARAMETERS* vui;
  if(hevc){
   auto& h=encConfig.encodeCodecConfig.hevcConfig;h.idrPeriod=30;h.repeatSPSPPS=1;
   h.outputPictureTimingSEI=1;h.outputBufferingPeriodSEI=1;
   h.inputBitDepth=h.outputBitDepth=tenBit?NV_ENC_BIT_DEPTH_10:NV_ENC_BIT_DEPTH_8;
   encConfig.profileGUID=tenBit?NV_ENC_HEVC_PROFILE_MAIN10_GUID:NV_ENC_HEVC_PROFILE_MAIN_GUID;
   vui=&h.hevcVUIParameters;
  }else{
   auto& h=encConfig.encodeCodecConfig.h264Config;h.idrPeriod=30;h.repeatSPSPPS=1;vui=&h.h264VUIParameters;
  }
  vui->videoSignalTypePresentFlag=1;vui->colourDescriptionPresentFlag=1;
  vui->colourPrimaries=(NV_ENC_VUI_COLOR_PRIMARIES)1;
  vui->transferCharacteristics=(NV_ENC_VUI_TRANSFER_CHARACTERISTIC)1;
  vui->colourMatrix=(NV_ENC_VUI_MATRIX_COEFFS)1;
  vui->timingInfoPresentFlag=1;vui->numUnitInTicks=1;vui->timeScale=hevc?30:60;
  NV_ENC_INITIALIZE_PARAMS init={NV_ENC_INITIALIZE_PARAMS_VER};init.encodeGUID=codecGuid;init.presetGUID=NV_ENC_PRESET_P4_GUID;
  init.encodeWidth=init.darWidth=width;init.encodeHeight=init.darHeight=height;init.frameRateNum=30;init.frameRateDen=1;init.enablePTD=1;init.encodeConfig=&encConfig;init.tuningInfo=NV_ENC_TUNING_INFO_HIGH_QUALITY;
  nv(api.nvEncInitializeEncoder(encoder,&init),"nvEncInitializeEncoder");
  CUdeviceptr input;size_t pitch;cu(cuMemAllocPitch(&input,&pitch,width*4,height,16),"cuMemAllocPitch");
  NV_ENC_REGISTER_RESOURCE registration={NV_ENC_REGISTER_RESOURCE_VER};registration.resourceType=NV_ENC_INPUT_RESOURCE_TYPE_CUDADEVICEPTR;
  registration.resourceToRegister=(void*)input;registration.width=width;registration.height=height;registration.pitch=pitch;registration.bufferFormat=tenBit?NV_ENC_BUFFER_FORMAT_ABGR10:NV_ENC_BUFFER_FORMAT_ABGR;registration.bufferUsage=NV_ENC_INPUT_IMAGE;
  nv(api.nvEncRegisterResource(encoder,&registration),"nvEncRegisterResource");
  NV_ENC_CREATE_BITSTREAM_BUFFER bits={NV_ENC_CREATE_BITSTREAM_BUFFER_VER};nv(api.nvEncCreateBitstreamBuffer(encoder,&bits),"nvEncCreateBitstreamBuffer");
  FILE* output=fopen(path,"wb");if(!output)throw std::runtime_error("Cannot create output");
  std::vector<unsigned char> host(cpu?width*height*4:0);unsigned long totalBytes=0;double transferMs=0,encodeMs=0,renderMs=0;
  double start=now();
  for(unsigned i=0;i<frames;i++){
   double tick=now();glBindFramebuffer(GL_FRAMEBUFFER,fbo);glViewport(0,0,width,height);glDisable(GL_SCISSOR_TEST);glClearColor(.1,.25,.4,1);glClear(GL_COLOR_BUFFER_BIT);
   glEnable(GL_SCISSOR_TEST);for(int j=0;j<8;j++){glScissor((i*13+j*211)%1500,j*119,400,96);glClearColor(float((i+j)%60)/60,.8,float(j)/8,1);glClear(GL_COLOR_BUFFER_BIT);}glDisable(GL_SCISSOR_TEST);glFinish();renderMs+=now()-tick;
   tick=now();CUDA_MEMCPY2D copy={};copy.WidthInBytes=width*4;copy.Height=height;
   if(eglFrame.frameType==CU_EGL_FRAME_TYPE_ARRAY){copy.srcMemoryType=CU_MEMORYTYPE_ARRAY;copy.srcArray=eglFrame.frame.pArray[0];}
   else{copy.srcMemoryType=CU_MEMORYTYPE_DEVICE;copy.srcDevice=(CUdeviceptr)eglFrame.frame.pPitch[0];copy.srcPitch=eglFrame.pitch;}
   if(cpu){copy.dstMemoryType=CU_MEMORYTYPE_HOST;copy.dstHost=host.data();copy.dstPitch=width*4;cu(cuMemcpy2D(&copy),"GPU to host");copy.srcMemoryType=CU_MEMORYTYPE_HOST;copy.srcHost=host.data();copy.srcPitch=width*4;}
   copy.dstMemoryType=CU_MEMORYTYPE_DEVICE;copy.dstDevice=input;copy.dstPitch=pitch;cu(cuMemcpy2D(&copy),cpu?"host to GPU":"GPU to GPU");cu(cuCtxSynchronize(),"copy fence");transferMs+=now()-tick;
   tick=now();NV_ENC_MAP_INPUT_RESOURCE mapped={NV_ENC_MAP_INPUT_RESOURCE_VER};mapped.registeredResource=registration.registeredResource;nv(api.nvEncMapInputResource(encoder,&mapped),"nvEncMapInputResource");
   NV_ENC_PIC_PARAMS picture={NV_ENC_PIC_PARAMS_VER};picture.inputBuffer=mapped.mappedResource;picture.bufferFmt=mapped.mappedBufferFmt;picture.inputWidth=width;picture.inputHeight=height;picture.inputPitch=pitch;picture.outputBitstream=bits.bitstreamBuffer;picture.pictureStruct=NV_ENC_PIC_STRUCT_FRAME;picture.inputTimeStamp=i;picture.inputDuration=1;
   if(i%30==0)picture.encodePicFlags=NV_ENC_PIC_FLAG_FORCEIDR;
   nv(api.nvEncEncodePicture(encoder,&picture),"nvEncEncodePicture");
   NV_ENC_LOCK_BITSTREAM lock={NV_ENC_LOCK_BITSTREAM_VER};lock.outputBitstream=bits.bitstreamBuffer;nv(api.nvEncLockBitstream(encoder,&lock),"nvEncLockBitstream");
   if(fwrite(lock.bitstreamBufferPtr,1,lock.bitstreamSizeInBytes,output)!=lock.bitstreamSizeInBytes)throw std::runtime_error("Output write failed");totalBytes+=lock.bitstreamSizeInBytes;
   nv(api.nvEncUnlockBitstream(encoder,bits.bitstreamBuffer),"nvEncUnlockBitstream");nv(api.nvEncUnmapInputResource(encoder,mapped.mappedResource),"nvEncUnmapInputResource");encodeMs+=now()-tick;
  }
  NV_ENC_PIC_PARAMS end={NV_ENC_PIC_PARAMS_VER};end.encodePicFlags=NV_ENC_PIC_FLAG_EOS;nv(api.nvEncEncodePicture(encoder,&end),"NVENC EOS");fclose(output);
  double elapsed=now()-start;
  printf("{\"path\":\"%s\",\"mode\":\"%s\",\"codec\":\"%s\",\"inputBits\":%d,\"renderer\":\"%s\",\"width\":%u,\"height\":%u,\"frames\":%u,\"bytes\":%lu,\"elapsedMs\":%.3f,\"fps\":%.3f,\"renderMs\":%.3f,\"transferMs\":%.3f,\"encodeMs\":%.3f,\"uncompressedCpuBytes\":%llu}\n",path,cpu?"GPU-CPU-GPU":"GPU-GPU",codec.c_str(),tenBit?10:8,renderer.c_str(),width,height,frames,totalBytes,elapsed,frames*1000/elapsed,renderMs,transferMs,encodeMs,cpu?2ULL*width*height*4*frames:0ULL);
  api.nvEncDestroyBitstreamBuffer(encoder,bits.bitstreamBuffer);api.nvEncUnregisterResource(encoder,registration.registeredResource);api.nvEncDestroyEncoder(encoder);cuMemFree(input);cuGraphicsUnregisterResource(resource);destroyImage(display,image);glDeleteFramebuffers(1,&fbo);glDeleteTextures(1,&texture);eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);eglDestroySurface(display,surface);eglDestroyContext(display,context);eglTerminate(display);cuCtxDestroy(cudaContext);dlclose(library);
  return 0;
 }catch(const std::exception& error){fprintf(stderr,"NATIVE_GPU_BENCH_FAILED: %s\n",error.what());return 1;}
}

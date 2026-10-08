// PROTOTYPE: native LiteRT-LM throughput and retrieval check; no Python runtime.
// Uses the upstream C ABI from C++ to avoid rebuilding the engine itself.
#include "c/embedding_engine.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using Clock = std::chrono::steady_clock;
double seconds(Clock::time_point start) {
  return std::chrono::duration<double>(Clock::now() - start).count();
}
std::string quote(const std::string& value) {
  std::string result = "\"";
  for (char c : value) {
    if (c == '\\' || c == '"') result += '\\';
    if (c == '\n') result += "\\n"; else result += c;
  }
  return result + "\"";
}
struct Frame { std::string name; std::vector<char> data; };

int main(int argc, char** argv) try {
  if (argc != 6) throw std::runtime_error("Usage: litert-bench MODEL cpu|gpu TOKENS FRAMES_DIR CACHE_DIR");
  const int tokens = std::stoi(argv[3]);
  const bool prefer_fp16 = std::getenv("WEFTCUT_LITERT_FP16") != nullptr;
  std::vector<Frame> frames;
  for (const auto& entry : std::filesystem::directory_iterator(argv[4])) {
    if (entry.path().extension() != ".png") continue;
    std::ifstream input(entry.path(), std::ios::binary);
    frames.push_back({entry.path().filename().string(), {std::istreambuf_iterator<char>(input), {}}});
  }
  std::sort(frames.begin(), frames.end(), [](const auto& a, const auto& b) { return a.name < b.name; });
  if (frames.empty()) throw std::runtime_error("No frames");
  std::ostringstream report;
  auto started = Clock::now();
  auto* settings = litert_lm_embedding_engine_settings_create(argv[1], argv[2], argv[2], nullptr);
  if (!settings) throw std::runtime_error("Settings failed");
  litert_lm_embedding_engine_settings_set_num_threads(settings, 8);
  litert_lm_embedding_engine_settings_set_max_input_length(settings, 256);
  litert_lm_embedding_engine_settings_set_vision_tokens_per_image(settings, tokens);
  litert_lm_embedding_engine_settings_set_cache_dir(settings, argv[5]);
  if (prefer_fp16) litert_lm_embedding_engine_settings_set_activation_data_type(settings, kLiteRtLmActivationDataTypeFloat16);
  auto* engine = litert_lm_embedding_engine_create(settings);
  litert_lm_embedding_engine_settings_delete(settings);
  if (!engine) throw std::runtime_error("Engine creation failed; see native stderr");
  const double load = seconds(started);
  auto* options = litert_lm_embedding_options_create();
  litert_lm_embedding_options_set_normalize(options, true);
  litert_lm_embedding_options_set_output_size(options, 768);
  litert_lm_embedding_options_set_vision_tokens_per_image(options, tokens);
  auto readVector = [](const LiteRtLmEmbeddingResponse* response) {
    if (!response) throw std::runtime_error("Embedding failed; see native stderr");
    const auto count = litert_lm_embedding_response_get_size(response);
    const auto* values = litert_lm_embedding_response_get_values(response);
    std::vector<float> vector(values, values + count);
    if (count != 768 || !std::all_of(vector.begin(), vector.end(), [](float x) { return std::isfinite(x); }))
      throw std::runtime_error("Invalid embedding");
    return vector;
  };
  auto embed = [&](LiteRtLmInputDataType type, const void* bytes, size_t size) {
    auto* input = litert_lm_input_data_create(type, bytes, size);
    const LiteRtLmInputData* inputs[] = {input};
    auto* response = litert_lm_embedding_engine_compute_embedding(engine, inputs, 1, options);
    litert_lm_input_data_delete(input);
    auto vector = readVector(response);
    litert_lm_embedding_response_delete(response);
    return vector;
  };
  std::vector<std::vector<float>> vectors;
  report << "{\"backend\":" << quote(argv[2]) << ",\"visionTokens\":" << tokens
            << ",\"requestedActivation\":" << quote(prefer_fp16 ? "float16" : "default")
            << ",\"batchSize\":4,\"frames\":" << frames.size() << ",\"loadSeconds\":" << load << ",\"runs\":[";
  for (int run = 0; run < 2; ++run) {
    vectors.clear();
    started = Clock::now();
    for (size_t offset = 0; offset < frames.size(); offset += 4) {
      const size_t count = std::min(size_t(4), frames.size() - offset);
      LiteRtLmInputData* owned[4];
      const LiteRtLmInputData* inputs[4];
      const LiteRtLmInputData* const* requests[4];
      const size_t sizes[] = {1, 1, 1, 1};
      for (size_t i = 0; i < count; ++i) {
        const auto& frame = frames[offset+i];
        owned[i] = litert_lm_input_data_create(kLiteRtLmInputDataTypeImage, frame.data.data(), frame.data.size());
        inputs[i] = owned[i];
        requests[i] = &inputs[i];
      }
      auto* responses = litert_lm_embedding_engine_compute_embedding_batch(engine, requests, sizes, count, options);
      for (size_t i = 0; i < count; ++i) litert_lm_input_data_delete(owned[i]);
      if (!responses || litert_lm_embedding_responses_get_size(responses) != count)
        throw std::runtime_error("Batch embedding failed");
      for (size_t i = 0; i < count; ++i) vectors.push_back(readVector(litert_lm_embedding_responses_get_at(responses, i)));
      litert_lm_embedding_responses_delete(responses);
      if (vectors.size() % 20 == 0) std::cerr << "Indexed " << vectors.size() << '/' << frames.size() << '\n';
    }
    const double duration = seconds(started);
    if (run) report << ',';
    report << "{\"seconds\":" << duration << ",\"fps\":" << frames.size()/duration << "}";
  }
  report << "],\"queries\":[";
  const std::vector<std::string> queries = {"打瞌睡的猫", "射箭的人", "打网球", "戴墨镜的小孩翻书", "卡通森林"};
  for (size_t q = 0; q < queries.size(); ++q) {
    started = Clock::now();
    const auto text = "task: search query | text: " + queries[q];
    auto query = embed(kLiteRtLmInputDataTypeText, text.data(), text.size());
    std::vector<double> scores;
    for (const auto& vector : vectors) scores.push_back(std::inner_product(query.begin(), query.end(), vector.begin(), 0.0));
    std::vector<size_t> order(scores.size()); std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(), [&](auto a, auto b) { return scores[a] > scores[b]; });
    const double query_ms = seconds(started)*1000;
    if (q) report << ',';
    report << "{\"query\":" << quote(queries[q]) << ",\"queryMs\":" << query_ms << ",\"hits\":[";
    for (size_t i = 0; i < std::min(size_t(3), order.size()); ++i) {
      if (i) report << ',';
      report << "{\"frame\":" << quote(frames[order[i]].name) << ",\"score\":" << scores[order[i]] << '}';
    }
    report << "]}";
  }
  report << "]}";
  std::cout << '\n' << report.str() << std::endl;
  litert_lm_embedding_options_delete(options);
  litert_lm_embedding_engine_delete(engine);
  return 0;
} catch (const std::exception& error) {
  std::cerr << "Benchmark failed: " << error.what() << std::endl;
  return 1;
}

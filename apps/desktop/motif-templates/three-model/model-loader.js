import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// New loaders for each setup: the host retires decoder workers when setup ends.
// All decoding completes before this Promise resolves. Paths are package-local.
export async function loadModel(url, renderer) {
  const draco = new DRACOLoader().setDecoderPath('./vendor/draco/').setWorkerLimit(2);
  const ktx2 = new KTX2Loader().setTranscoderPath('./vendor/basis/').setWorkerLimit(2);
  ktx2.detectSupport(renderer);
  const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  let gltf;
  try {
    gltf = await loader.loadAsync(url);
    // GLTFLoader deliberately turns texture errors into null. A Motif must
    // not silently bake/export a successful frame with missing textures.
    const textures = await gltf.parser.getDependencies('texture');
    const missing = textures.findIndex(texture => !texture);
    if (missing !== -1) {
      const definition = gltf.parser.json.textures[missing];
      const source = definition.extensions?.KHR_texture_basisu?.source ?? definition.source;
      const image = gltf.parser.json.images?.[source];
      throw new Error('Texture failed: ' + (image?.uri ?? `embedded texture ${missing}`));
    }
    return gltf;
  } catch (error) {
    disposeModel(gltf?.scene);
    throw new Error(`Could not load model ${url}: ${error.message ?? error}`);
  } finally {
    draco.dispose();
    ktx2.dispose();
  }
}

// Textures can be shared by several materials, geometries by several meshes.
export function disposeModel(root) {
  const resources = new Set();
  root?.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of [].concat(object.material ?? [])) {
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
    if (object.skeleton) resources.add(object.skeleton);
  });
  const images = new Set();
  for (const resource of resources) {
    if (resource.isTexture && resource.source?.data?.close) images.add(resource.source.data);
    resource.dispose();
  }
  for (const image of images) image.close();
}

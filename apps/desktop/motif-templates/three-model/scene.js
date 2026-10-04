import * as THREE from 'three';
import { loadModel, disposeModel } from './vendor/model-loader.js';

let renderer, scene, camera, pivot, model, mixer, actions = [], speed = 0.5;
motif.define({
  async setup(props, ctx) {
    speed = props.speed;
    if (mixer && model) { mixer.stopAllAction(); mixer.uncacheRoot(model); }
    disposeModel(model); model = null;
    renderer?.dispose(); document.body.replaceChildren();
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(1); renderer.setSize(ctx.width, ctx.height);
    document.body.append(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, ctx.width / ctx.height, 0.01, 100);
    camera.position.set(0, 0.5, 4); camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x657087, 3));
    const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(3, 4, 5); scene.add(key);
    const gltf = await loadModel(props.model, renderer);
    model = gltf.scene;
    model.traverse(object => { if (object.isMesh && !object.geometry.attributes.normal) object.geometry.computeVertexNormals(); });
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const scale = 1.6 / Math.max(size.x, size.y, size.z, 0.001);
    const centered = new THREE.Group(); centered.add(model); centered.position.copy(center).negate();
    pivot = new THREE.Group(); pivot.add(centered); pivot.scale.setScalar(scale * props.scale); scene.add(pivot);
    mixer = new THREE.AnimationMixer(model);
    actions = gltf.animations.map(clip => mixer.clipAction(clip).play());
  },
  frame(t, ctx) {
    if (renderer.domElement.width !== ctx.width || renderer.domElement.height !== ctx.height) {
      renderer.setSize(ctx.width, ctx.height);
      camera.aspect = ctx.width / ctx.height; camera.updateProjectionMatrix();
    }
    // Reset animation actions for backward seeks and repeated timestamps.
    for (const action of actions) action.reset().play();
    mixer.setTime(t);
    pivot.rotation.y = t * speed;
    renderer.render(scene, camera);
  }
});

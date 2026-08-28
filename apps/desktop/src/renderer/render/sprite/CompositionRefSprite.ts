// A Group layer's picture: its composition, composited by a child
// `CompositionNode` into a `RenderTexture` of the composition's own
// `width × height`, shown by one `Sprite`. Render-to-texture rather than
// staging the child's container directly, so the parent's `stageVisual` can
// treat the Group like any other visual — transform, opacity, effect filters
// and the transition divert all apply to one flat image, exactly as they
// would to a decoded frame — and so a Group's own transitions and blend
// stack resolve inside its frame before the parent sees it. Precedents:
// `MotifSprite` (an external image in a Sprite), `transitions/TransitionNodes`
// (render-to-texture inside a frame).
//
// Time: `update(view, tInLayerUs)` composites the child at
// `src_in + tInLayerUs`. Outside `[0, duration_us)` the child composites
// nothing and the texture clears to transparent — overhang is tolerated in
// state and rendered as nothing (ADR 0052 §6).

import { RenderTexture, Sprite } from "pixi.js";
import type { Container, Renderer } from "pixi.js";

import type { CompositionSummary, ProjectSummary } from "../../ipc";
import { anchorPivot } from "../anchorPivot";
import { compositionLocalUs } from "../compositionWalk";
import type { CompositionNode, EffectOpts } from "../CompositionNode";
import type { ResolvedCompositionRefView } from "../resolveView";
import type { StageableSprite } from "./StageableSprite";

/// The texture clears to transparent each frame — the composition's own
/// background is a layer inside it when it has one, never this clear.
const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

export interface CompositionRefSpriteInit {
  layerId: string;
  /// The child node, owned from here on: disposed with the sprite.
  node: CompositionNode;
  /// Undefined only in renderer-less unit tests; nothing renders then.
  renderer: Renderer | undefined;
}

export class CompositionRefSprite implements StageableSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly node: CompositionNode;
  private readonly renderer: Renderer | undefined;
  private texture: RenderTexture;
  private disposed = false;

  constructor(init: CompositionRefSpriteInit) {
    this.layerId = init.layerId;
    this.node = init.node;
    this.renderer = init.renderer;
    this.texture = this.createTexture(init.node.composition.width, init.node.composition.height);
    this.sprite = new Sprite(this.texture);
  }

  get displayObject(): Container {
    return this.sprite;
  }

  /// Always: the texture is a real render target from construction, and a
  /// Group past its window is a transparent one, not an unstaged one.
  get stageReady(): boolean {
    return true;
  }

  /// The composition's frame — what the gizmo boxes.
  naturalSize(): { w: number; h: number } {
    return { w: this.texture.width, h: this.texture.height };
  }

  /// A new snapshot of the composition this Group points at (same id). The
  /// texture follows a size change; the node re-reads its layers.
  setComposition(composition: CompositionSummary, summary: ProjectSummary | null): void {
    if (this.disposed) return;
    if (composition.width !== this.texture.width || composition.height !== this.texture.height) {
      this.texture.destroy(true);
      this.texture = this.createTexture(composition.width, composition.height);
      this.sprite.texture = this.texture;
      this.node.setSize(composition.width, composition.height);
    }
    this.node.setComposition(composition, summary);
  }

  /// Apply the layer's transform, composite the child at the mapped time and
  /// render it into the texture. Runs inside the parent's sweep, before the
  /// parent stages this sprite, so the parent's own render (or its transition
  /// bake) samples THIS frame's pixels.
  update(view: ResolvedCompositionRefView, tInLayerUs: number, effectOpts: EffectOpts): void {
    if (this.disposed) return;
    // Transforms first, every tick: the texture's extent is the local space,
    // and the anchor pivots within it (anchorPivot.ts) like every other kind.
    this.sprite.scale.set(view.scale_x, view.scale_y);
    const pivot = anchorPivot({
      x: view.x,
      y: view.y,
      anchorX: view.anchor_x,
      anchorY: view.anchor_y,
      texW: this.texture.width,
      texH: this.texture.height,
      effScaleX: view.scale_x,
      effScaleY: view.scale_y,
    });
    this.sprite.pivot.set(pivot.pivotX, pivot.pivotY);
    this.sprite.position.set(pivot.posX, pivot.posY);
    this.sprite.angle = view.rotation_deg;
    this.sprite.alpha = view.opacity;

    const comp = this.node.composition;
    const tChildUs = compositionLocalUs(
      view.src_in_us + tInLayerUs,
      comp.fps_num,
      comp.fps_den,
    );
    if (tChildUs < 0 || tChildUs >= comp.duration_us) {
      this.node.compositeNothing();
    } else {
      this.node.compositeVisual(tChildUs, effectOpts);
    }
    this.renderer?.render({
      container: this.node.container,
      target: this.texture,
      clear: true,
      clearColor: TRANSPARENT,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.node.dispose();
    try {
      this.texture.destroy(true);
    } catch {
      // ignore
    }
    this.sprite.destroy({ children: true });
  }

  /// WebGPU LANDMINE, shared with TransitionNodes: Pixi's WebGPU pipelines
  /// hard-code bgra8unorm color targets, so an rgba8unorm RT trips Dawn's
  /// attachment validation and every render into it is silently dropped.
  /// WebGL keeps rgba8unorm. An 8-bit target means the 10-bit export lane
  /// quantizes through a Group — the same v1 trade the transition node makes.
  private createTexture(width: number, height: number): RenderTexture {
    const format =
      this.renderer && "gl" in this.renderer ? ("rgba8unorm" as const) : ("bgra8unorm" as const);
    return RenderTexture.create({
      width: Math.max(1, width),
      height: Math.max(1, height),
      format,
    });
  }
}

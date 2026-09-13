import { describe, expect, it } from 'vitest';
import { desktopPoint } from './desktopPoint';
import { magnifierPosition } from './magnifier';

describe('physical desktop sampling', () => {
  it('round-trips the real 110% PointerEvent without a one-pixel drift', () => {
    expect(desktopPoint(109.09090423583984,90.90908813476562,1.100000023841858,1920,1080)).toEqual({x:120,y:100});
  });
  it('maps independently in each display, without multiplying global desktop origins', () => {
    expect(desktopPoint(80,60,1,1920,1080)).toEqual({x:80,y:60});
    expect(desktopPoint(80,60,2,3840,2160)).toEqual({x:160,y:120});
  });
  it('refuses out-of-image chrome and invalid geometry', () => {
    expect(desktopPoint(1746,0,1.1,1920,1080)).toBeNull();
    expect(desktopPoint(-1,0,1,1920,1080)).toBeNull();
    expect(desktopPoint(1,1,NaN,1920,1080)).toBeNull();
  });
  it('keeps the magnifier inside the actual visible extent', () => {
    expect(magnifierPosition(1919,1079,150,180,1920,1080)).toEqual({x:1766,y:896});
  });
});

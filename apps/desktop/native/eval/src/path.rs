//! Distance-based motion over an adaptively flattened path. The same samples
//! and lookup serve native callers and the Wasm preview. No heap is required.
pub const MAX_NODES: usize = 128;
pub const MAX_SAMPLES: usize = (MAX_NODES - 1) * 512 + 1;
pub const TOLERANCE: f64 = 0.01;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
impl Point {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };
    fn add(self, b: Self) -> Self {
        Self {
            x: self.x + b.x,
            y: self.y + b.y,
        }
    }
    fn sub(self, b: Self) -> Self {
        Self {
            x: self.x - b.x,
            y: self.y - b.y,
        }
    }
    fn mul(self, s: f64) -> Self {
        Self {
            x: self.x * s,
            y: self.y * s,
        }
    }
    fn distance(self, b: Self) -> f64 {
        let d = self.sub(b);
        libm::sqrt(d.x * d.x + d.y * d.y)
    }
    fn unit(self) -> Self {
        let n = self.distance(Self::ZERO);
        if n > 0.0 {
            self.mul(1.0 / n)
        } else {
            Self::ZERO
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Node {
    pub point: Point,
    pub incoming: Point,
    pub outgoing: Point,
    pub cubic: bool,
}
impl Node {
    pub const ZERO: Self = Self {
        point: Point::ZERO,
        incoming: Point::ZERO,
        outgoing: Point::ZERO,
        cubic: false,
    };
}

fn flatten(p: [Point; 4], depth: u8, t0: f64, t1: f64, emit: &mut impl FnMut(Point, f64)) {
    let chord = p[0].distance(p[3]);
    let polygon = p[0].distance(p[1]) + p[1].distance(p[2]) + p[2].distance(p[3]);
    // Distance from controls to the chord also bounds geometric deviation.
    let deviation = if chord > 0.0 {
        let d = p[3].sub(p[0]);
        let a = p[1].sub(p[0]);
        let b = p[2].sub(p[0]);
        libm::fabs(d.x * a.y - d.y * a.x).max(libm::fabs(d.x * b.y - d.y * b.x)) / chord
    } else {
        polygon
    };
    if depth == 9 || (polygon - chord <= TOLERANCE && deviation <= TOLERANCE) {
        emit(p[3], t1);
        return;
    }
    let a = p[0].add(p[1]).mul(0.5);
    let b = p[1].add(p[2]).mul(0.5);
    let c = p[2].add(p[3]).mul(0.5);
    let d = a.add(b).mul(0.5);
    let e = b.add(c).mul(0.5);
    let m = d.add(e).mul(0.5);
    let tm = (t0 + t1) * 0.5;
    flatten([p[0], a, d, m], depth + 1, t0, tm, emit);
    flatten([m, e, c, p[3]], depth + 1, tm, t1, emit);
}

/// Emits (x, y, cumulative distance, segment-index + parameter). The parameter
/// lets authoring map fitted spatial points back to the SAME distance table.
pub fn compile(nodes: &[Node], mut emit: impl FnMut([f64; 4])) -> (Point, Point) {
    let Some(first) = nodes.first() else {
        return (Point::ZERO, Point::ZERO);
    };
    let mut last = first.point;
    let mut length = 0.0;
    emit([last.x, last.y, 0.0, 0.0]);
    for (index, pair) in nodes.windows(2).enumerate() {
        let a = pair[0];
        let b = pair[1];
        let mut append = |p: Point, t: f64| {
            length += last.distance(p);
            last = p;
            emit([p.x, p.y, length, index as f64 + t]);
        };
        if a.cubic {
            flatten(
                [
                    a.point,
                    a.point.add(a.outgoing),
                    b.point.add(b.incoming),
                    b.point,
                ],
                0,
                0.0,
                1.0,
                &mut append,
            );
        } else {
            append(b.point, 1.0);
        }
    }
    let mut start = Point::ZERO;
    let mut end = Point::ZERO;
    for pair in nodes.windows(2) {
        let a = pair[0];
        let b = pair[1];
        let candidates = if a.cubic {
            [
                a.outgoing,
                b.point.add(b.incoming).sub(a.point),
                b.point.sub(a.point),
            ]
        } else {
            [b.point.sub(a.point); 3]
        };
        for d in candidates {
            if d != Point::ZERO {
                start = d.unit();
                break;
            }
        }
        if start != Point::ZERO {
            break;
        }
    }
    for pair in nodes.windows(2).rev() {
        let a = pair[0];
        let b = pair[1];
        let candidates = if a.cubic {
            [
                b.incoming.mul(-1.0),
                b.point.sub(a.point.add(a.outgoing)),
                b.point.sub(a.point),
            ]
        } else {
            [b.point.sub(a.point); 3]
        };
        for d in candidates {
            if d != Point::ZERO {
                end = d.unit();
                break;
            }
        }
        if end != Point::ZERO {
            break;
        }
    }
    (start, end)
}

pub fn evaluate(samples: &[[f64; 4]], progress: f64, start: Point, end: Point) -> Point {
    let Some(a) = samples.first() else {
        return Point::ZERO;
    };
    let b = samples[samples.len() - 1];
    let total = b[2];
    let first = Point { x: a[0], y: a[1] };
    let last = Point { x: b[0], y: b[1] };
    if total == 0.0 || !progress.is_finite() {
        return first;
    }
    if progress <= 0.0 {
        return first.add(start.mul(progress * total));
    }
    if progress >= 1.0 {
        return last.add(end.mul((progress - 1.0) * total));
    }
    let distance = progress * total;
    let mut lo = 1;
    let mut hi = samples.len() - 1;
    while lo < hi {
        let m = (lo + hi) / 2;
        if samples[m][2] < distance {
            lo = m + 1;
        } else {
            hi = m;
        }
    }
    let a = samples[lo - 1];
    let b = samples[lo];
    let u = if b[2] > a[2] {
        (distance - a[2]) / (b[2] - a[2])
    } else {
        0.0
    };
    Point {
        x: a[0] + (b[0] - a[0]) * u,
        y: a[1] + (b[1] - a[1]) * u,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(x: f64, y: f64) -> Node {
        Node {
            point: Point { x, y },
            ..Node::ZERO
        }
    }
    #[test]
    fn samples_retain_ordered_segment_parameters() {
        let mut nodes = [line(0.0, 0.0), line(100.0, 0.0), line(150.0, 0.0)];
        nodes[0].cubic = true;
        nodes[0].outgoing = Point { x: 0.0, y: 100.0 };
        nodes[1].incoming = Point { x: 0.0, y: 100.0 };
        let mut samples = Vec::new();
        compile(&nodes, |p| samples.push(p));
        assert_eq!(samples[0][3], 0.0);
        assert_eq!(samples.last().unwrap()[3], 2.0);
        assert!(samples.iter().any(|s| s[3] > 0.0 && s[3] < 1.0));
        assert!(samples.iter().any(|s| s[3] == 1.0));
        assert!(samples
            .windows(2)
            .all(|p| p[0][3] < p[1][3] && p[0][2] <= p[1][2]));
    }
    #[test]
    fn distance_uses_length_not_node_count() {
        let mut s = Vec::new();
        let (a, b) = compile(&[line(0.0, 0.0), line(10.0, 0.0), line(10.0, 90.0)], |p| {
            s.push(p)
        });
        assert_eq!(evaluate(&s, 0.5, a, b), Point { x: 10.0, y: 40.0 });
        assert_eq!(evaluate(&s, -0.1, a, b), Point { x: -10.0, y: 0.0 });
        assert!((evaluate(&s, 1.1, a, b).y - 100.0).abs() < 1e-12);
    }
    #[test]
    fn loop_with_coincident_endpoints_does_not_collapse() {
        let mut a = line(0.0, 0.0);
        a.cubic = true;
        a.outgoing = Point { x: 100.0, y: 100.0 };
        let mut b = a;
        b.incoming = Point {
            x: -100.0,
            y: 100.0,
        };
        let mut s = Vec::new();
        let (u, v) = compile(&[a, b], |p| s.push(p));
        assert!(s.last().unwrap()[2] > 100.0);
        assert!(evaluate(&s, 0.5, u, v).y > 70.0);
    }
    #[test]
    fn repeated_points_stay_finite() {
        let mut s = Vec::new();
        let (a, b) = compile(&[line(3.0, 4.0); 3], |p| s.push(p));
        assert_eq!(evaluate(&s, 2.0, a, b), Point { x: 3.0, y: 4.0 });
    }
}

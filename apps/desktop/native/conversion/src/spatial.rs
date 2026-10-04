//! Ordered least-squares spatial fitting. Port of the former TS fitter; the
//! path compiler and distance parameterization use the playback evaluator.
use weftcut_eval::path::{self, Node, Point};

struct Span {
    first: usize,
    last: usize,
    outgoing: Point,
    incoming: Point,
    error: f64,
    split: usize,
    line: bool,
}
pub struct Fit {
    pub nodes: Vec<Node>,
    pub progress: Vec<f64>,
    pub limited: bool,
}
fn dot(a: Point, b: Point) -> f64 {
    a.x * b.x + a.y * b.y
}
fn parameter(distance: &[f64], i: usize, a: usize, b: usize) -> f64 {
    let total = distance[b] - distance[a];
    if total > 1e-12 {
        (distance[i] - distance[a]) / total
    } else {
        0.0
    }
}
fn fit_span(points: &[Point], distance: &[f64], first: usize, last: usize, tolerance: f64) -> Span {
    let (p, q) = (points[first], points[last]);
    let mut next = (first + 1).min(last);
    let mut previous = last.saturating_sub(1).max(first);
    while next < last && points[next].distance(p) < 1e-12 {
        next += 1;
    }
    while previous > first && points[previous].distance(q) < 1e-12 {
        previous -= 1;
    }
    let (left, right) = (
        points[next].minus(p).unit(),
        points[previous].minus(q).unit(),
    );
    let (mut c00, mut c01, mut c11, mut x0, mut x1) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (i, point) in points.iter().enumerate().take(last + 1).skip(first) {
        let u = parameter(distance, i, first, last);
        let v = 1.0 - u;
        let (b0, b1, b2, b3) = (v * v * v, 3.0 * u * v * v, 3.0 * u * u * v, u * u * u);
        let residual = point.minus(p.scaled(b0 + b1)).minus(q.scaled(b2 + b3));
        c00 += b1 * b1;
        c01 += dot(left, right) * b1 * b2;
        c11 += b2 * b2;
        x0 += dot(left, residual) * b1;
        x1 += dot(right, residual) * b2;
    }
    let det = c00 * c11 - c01 * c01;
    let length = distance[last] - distance[first];
    let mut a = if det > 1e-12 {
        (x0 * c11 - x1 * c01) / det
    } else {
        length / 3.0
    };
    let mut b = if det > 1e-12 {
        (x1 * c00 - x0 * c01) / det
    } else {
        length / 3.0
    };
    if a < 0.0 || b < 0.0 || a > length * 3.0 || b > length * 3.0 {
        a = length / 3.0;
        b = a;
    }
    let (outgoing, incoming) = (left.scaled(a), right.scaled(b));
    let (mut error, mut line_error, mut split) = (0.0_f64, 0.0_f64, (first + last) / 2);
    for (i, point) in points.iter().enumerate().take(last).skip(first + 1) {
        let u = parameter(distance, i, first, last);
        let v = 1.0 - u;
        let (b1, b2) = (3.0 * u * v * v, 3.0 * u * u * v);
        let fitted = p
            .scaled(v * v * v + b1)
            .plus(outgoing.scaled(b1))
            .plus(q.scaled(u * u * u + b2))
            .plus(incoming.scaled(b2));
        let e = fitted.distance(*point);
        if e > error {
            error = e;
            split = i;
        }
        line_error = line_error.max(p.plus(q.minus(p).scaled(u)).distance(*point));
    }
    let line = line_error <= tolerance;
    Span {
        first,
        last,
        outgoing,
        incoming,
        error: if line { line_error } else { error },
        split,
        line,
    }
}
pub fn fit(points: &[Point], tolerance: f64) -> Fit {
    let mut distance = vec![0.0; points.len()];
    for i in 1..points.len() {
        distance[i] = distance[i - 1] + points[i].distance(points[i - 1]);
    }
    if distance[points.len() - 1] == 0.0 {
        return Fit {
            nodes: vec![Node {
                point: points[0],
                ..Node::ZERO
            }],
            progress: vec![0.0; points.len()],
            limited: false,
        };
    }
    let mut spans = vec![fit_span(points, &distance, 0, points.len() - 1, tolerance)];
    while spans.len() < path::MAX_NODES - 1 {
        let worst = spans
            .iter()
            .enumerate()
            .filter(|(_, s)| s.error > tolerance)
            .max_by(|(_, a), (_, b)| a.error.total_cmp(&b.error))
            .map(|(i, _)| i);
        let Some(i) = worst else { break };
        let s = &spans[i];
        if s.split <= s.first || s.split >= s.last {
            break;
        }
        let replacements = [
            fit_span(points, &distance, s.first, s.split, tolerance),
            fit_span(points, &distance, s.split, s.last, tolerance),
        ];
        spans.splice(i..=i, replacements);
    }
    let mut nodes = vec![Node {
        point: points[0],
        ..Node::ZERO
    }];
    let mut parameters = vec![0.0; points.len()];
    for (segment, s) in spans.iter().enumerate() {
        let a = nodes.last_mut().unwrap();
        let mut b = Node {
            point: points[s.last],
            ..Node::ZERO
        };
        if !s.line {
            a.cubic = true;
            a.outgoing = s.outgoing;
            b.incoming = s.incoming;
        }
        nodes.push(b);
        for (i, p) in parameters
            .iter_mut()
            .enumerate()
            .take(s.last + 1)
            .skip(s.first)
        {
            *p = segment as f64 + parameter(&distance, i, s.first, s.last);
        }
    }
    let mut samples = Vec::new();
    path::compile(&nodes, |s| samples.push(s));
    let length = samples.last().unwrap()[2];
    let progress = parameters
        .iter()
        .map(|&p| {
            if p <= 0.0 || length == 0.0 {
                return 0.0;
            }
            if p >= (nodes.len() - 1) as f64 {
                return 1.0;
            }
            let i = samples.partition_point(|s| s[3] < p).max(1);
            let (a, b) = (samples[i - 1], samples[i]);
            let segment = p.floor() as usize;
            let u = p - segment as f64;
            let v = 1.0 - u;
            let (n, m) = (nodes[segment], nodes[segment + 1]);
            let point = if n.cubic {
                n.point
                    .scaled(v * v * v)
                    .plus(n.point.plus(n.outgoing).scaled(3.0 * u * v * v))
                    .plus(m.point.plus(m.incoming).scaled(3.0 * u * u * v))
                    .plus(m.point.scaled(u * u * u))
            } else {
                n.point.plus(m.point.minus(n.point).scaled(u))
            };
            let d = Point {
                x: b[0] - a[0],
                y: b[1] - a[1],
            };
            let squared = dot(d, d);
            let fraction = if squared > 0.0 {
                (dot(point.minus(Point { x: a[0], y: a[1] }), d) / squared).clamp(0.0, 1.0)
            } else {
                0.0
            };
            (a[2] + fraction * (b[2] - a[2])) / length
        })
        .collect();
    Fit {
        nodes,
        progress,
        limited: spans.iter().any(|s| s.error > tolerance),
    }
}

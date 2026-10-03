use super::{calculate, Affine, Error, Exact, MAX_SAFE_INTEGER};
use serde::Deserialize;

#[derive(Deserialize)]
struct ArithmeticCase {
    name: String,
    op: u32,
    a: [i64; 2],
    b: [i64; 2],
    expect: [i64; 2],
}

#[derive(Deserialize)]
struct MapCase {
    name: String,
    origin: [i64; 2],
    rate: [i64; 2],
    local: [i64; 2],
    content: [i64; 2],
}

#[derive(Deserialize)]
struct Fixture {
    arithmetic: Vec<ArithmeticCase>,
    mapping: Vec<MapCase>,
}

fn x(pair: [i64; 2]) -> Exact {
    Exact::from_wire(pair[0], pair[1]).unwrap()
}

#[test]
fn shared_vectors_match_native_and_wasm() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../fixtures/time-remapping/exact.json"
    ))
    .unwrap();
    for case in fixture.arithmetic {
        assert_eq!(
            calculate(case.op, x(case.a), x(case.b)),
            Ok(x(case.expect)),
            "{}",
            case.name
        );
    }
    for case in fixture.mapping {
        let map = Affine::new(x(case.origin), x(case.rate)).unwrap();
        assert_eq!(map.map(x(case.local)), Ok(x(case.content)), "{}", case.name);
        assert_eq!(
            map.inverse(x(case.content)),
            Ok(x(case.local)),
            "{}",
            case.name
        );
    }
}

#[test]
fn construction_normalizes_but_wire_reading_refuses_noncanonical_values() {
    assert_eq!(Exact::new(6, -8), Ok(x([-3, 4])));
    assert_eq!(Exact::new(0, -9), Ok(Exact::ZERO));
    assert_eq!(Exact::from_wire(2, 4), Err(Error::NonCanonical));
    assert_eq!(Exact::from_wire(1, -2), Err(Error::NonCanonical));
    assert_eq!(Exact::from_wire(0, 0), Err(Error::ZeroDenominator));
    assert_eq!(Exact::new(i64::MIN, 1), Err(Error::InvalidNumber));
    assert_eq!(
        Exact::from_scalars(f64::NAN, 1.0),
        Err(Error::InvalidNumber)
    );
    assert_eq!(
        Exact::from_scalars(f64::INFINITY, 1.0),
        Err(Error::InvalidNumber)
    );
    assert_eq!(Exact::from_scalars(0.5, 1.0), Err(Error::InvalidNumber));
    assert_eq!(Exact::from_scalars(1.0, 0.0), Err(Error::ZeroDenominator));
}

#[test]
fn invalid_rates_and_unrepresentable_results_are_errors() {
    assert_eq!(
        Affine::new(Exact::ZERO, Exact::ZERO),
        Err(Error::NonPositiveRate)
    );
    assert_eq!(
        Affine::new(Exact::ZERO, x([-1, 1])),
        Err(Error::NonPositiveRate)
    );
    assert_eq!(
        Exact::ONE.divided_by(Exact::ZERO),
        Err(Error::ZeroDenominator)
    );
    let max = Exact::new(MAX_SAFE_INTEGER as i64, 1).unwrap();
    assert_eq!(max.plus(Exact::ONE), Err(Error::Overflow));
    assert_eq!(max.times(max), Err(Error::Overflow));
    assert_eq!(max.divided_by(max), Ok(Exact::ONE));
}

#[test]
fn composed_maps_and_rebased_splits_keep_the_same_source_phase() {
    let outer = Affine::new(x([7, 3]), x([1001, 1000])).unwrap();
    let inner = Affine::new(x([1, 7]), x([3, 2])).unwrap();
    let composed = outer.compose(inner).unwrap();
    for i in -100..100 {
        let local = Exact::new(i * 125, 6).unwrap();
        assert_eq!(composed.map(local), outer.map(inner.map(local).unwrap()));
    }
    let mut right = outer;
    let mut elapsed = Exact::ZERO;
    for _ in 0..1_000 {
        let step = x([125, 6]);
        elapsed = elapsed.plus(step).unwrap();
        right = Affine::new(right.map(step).unwrap(), right.rate()).unwrap();
        assert_eq!(right.origin, outer.map(elapsed).unwrap());
    }
}

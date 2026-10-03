//! Exact time arithmetic shared by native consumers and the Wasm editor.
//!
//! Every public value fits JSON's safe-integer range. Products of two such
//! fractions and the sum of their cross products fit i128 (at most 107 bits).
//! Each operation reduces BEFORE checking its result's wire range. Callers
//! propagate Overflow; they must never fall back to floating-point arithmetic.
//! No heap, decoder, project state or frame-grid dependency.

pub const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    InvalidNumber = 1,
    ZeroDenominator = 2,
    Overflow = 3,
    NonCanonical = 4,
    NonPositiveRate = 5,
    InvalidRange = 6,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exact {
    num: i64,
    den: i64,
}

fn gcd(mut a: i128, mut b: i128) -> i128 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

impl Exact {
    pub const ZERO: Self = Self { num: 0, den: 1 };
    pub const ONE: Self = Self { num: 1, den: 1 };

    fn reduced(num: i128, den: i128) -> Result<Self, Error> {
        if den == 0 {
            return Err(Error::ZeroDenominator);
        }
        // Private: inputs come only from products/sums of safe i64 components,
        // so abs/neg cannot encounter i128::MIN.
        let divisor = gcd(num.abs(), den.abs());
        let sign = if den < 0 { -1 } else { 1 };
        let n = num / divisor * sign;
        let d = den / divisor * sign;
        if n.abs() > MAX_SAFE_INTEGER || d > MAX_SAFE_INTEGER {
            return Err(Error::Overflow);
        }
        Ok(Self {
            num: n as i64,
            den: d as i64,
        })
    }

    /// Construct from integer input, normalizing sign and common factors.
    pub fn new(num: i64, den: i64) -> Result<Self, Error> {
        if (num as i128).abs() > MAX_SAFE_INTEGER || (den as i128).abs() > MAX_SAFE_INTEGER {
            return Err(Error::InvalidNumber);
        }
        Self::reduced(num as i128, den as i128)
    }

    /// Read persisted data strictly. Construction may normalize; loading may
    /// not silently repair unknown or non-canonical timing data.
    pub fn from_wire(num: i64, den: i64) -> Result<Self, Error> {
        let result = Self::new(num, den)?;
        if result.num != num || result.den != den {
            return Err(Error::NonCanonical);
        }
        Ok(result)
    }

    /// f64 is transport only. Check BEFORE casting (Rust's cast saturates).
    pub fn from_scalars(num: f64, den: f64) -> Result<Self, Error> {
        let result = Self::from_unreduced_scalars(num, den)?;
        if result.num as f64 != num || result.den as f64 != den {
            return Err(Error::NonCanonical);
        }
        Ok(result)
    }

    pub fn from_unreduced_scalars(num: f64, den: f64) -> Result<Self, Error> {
        if !num.is_finite()
            || !den.is_finite()
            || libm::fabs(num) > MAX_SAFE_INTEGER as f64
            || libm::fabs(den) > MAX_SAFE_INTEGER as f64
            || num != libm::trunc(num)
            || den != libm::trunc(den)
        {
            return Err(Error::InvalidNumber);
        }
        Self::new(num as i64, den as i64)
    }

    pub const fn num(self) -> i64 {
        self.num
    }

    pub const fn den(self) -> i64 {
        self.den
    }

    pub fn plus(self, rhs: Self) -> Result<Self, Error> {
        Self::reduced(
            self.num as i128 * rhs.den as i128 + rhs.num as i128 * self.den as i128,
            self.den as i128 * rhs.den as i128,
        )
    }

    pub fn minus(self, rhs: Self) -> Result<Self, Error> {
        Self::reduced(
            self.num as i128 * rhs.den as i128 - rhs.num as i128 * self.den as i128,
            self.den as i128 * rhs.den as i128,
        )
    }

    pub fn times(self, rhs: Self) -> Result<Self, Error> {
        Self::reduced(
            self.num as i128 * rhs.num as i128,
            self.den as i128 * rhs.den as i128,
        )
    }

    pub fn divided_by(self, rhs: Self) -> Result<Self, Error> {
        Self::reduced(
            self.num as i128 * rhs.den as i128,
            self.den as i128 * rhs.num as i128,
        )
    }

    pub fn compare(self, rhs: Self) -> core::cmp::Ordering {
        (self.num as i128 * rhs.den as i128).cmp(&(rhs.num as i128 * self.den as i128))
    }

    /// Same half-up policy as the frame lattice, including negative queries:
    /// -1/2 -> 0, -3/2 -> -1. Only a consumer boundary may call this.
    pub fn round(self) -> i64 {
        (self.num as i128 * 2 + self.den as i128).div_euclid(self.den as i128 * 2) as i64
    }

    pub fn floor(self) -> i64 {
        self.num.div_euclid(self.den)
    }

    pub fn ceil(self) -> i64 {
        -(-self.num).div_euclid(self.den)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Affine {
    pub origin: Exact,
    rate: Exact,
}

impl Affine {
    pub fn new(origin: Exact, rate: Exact) -> Result<Self, Error> {
        if rate.num <= 0 {
            return Err(Error::NonPositiveRate);
        }
        Ok(Self { origin, rate })
    }

    pub const fn rate(self) -> Exact {
        self.rate
    }

    /// Linear extension is intentional: transitions query borrowed handles.
    /// Visibility and source availability are separate from the map.
    pub fn map(self, local: Exact) -> Result<Exact, Error> {
        self.origin.plus(local.times(self.rate)?)
    }

    pub fn inverse(self, content: Exact) -> Result<Exact, Error> {
        content.minus(self.origin)?.divided_by(self.rate)
    }

    /// `self` maps intermediate -> content; `inner` maps local -> intermediate.
    pub fn compose(self, inner: Self) -> Result<Self, Error> {
        Self::new(self.map(inner.origin)?, self.rate.times(inner.rate)?)
    }
}

/// Scalar ABI operation table, also tested natively. Codes are append-only.
pub fn calculate(op: u32, a: Exact, b: Exact) -> Result<Exact, Error> {
    match op {
        0 => a.plus(b),
        1 => a.minus(b),
        2 => a.times(b),
        3 => a.divided_by(b),
        4 => Exact::new(a.compare(b) as i64, 1),
        5 => Exact::new(a.round(), 1),
        6 => Exact::new(a.floor(), 1),
        7 => Exact::new(a.ceil(), 1),
        _ => Err(Error::InvalidNumber),
    }
}

#[cfg(test)]
mod tests;

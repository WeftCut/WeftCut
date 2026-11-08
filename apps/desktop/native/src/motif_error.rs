//! Typed Motif failures on the napi wire: a `[motif:<code>] detail` tag in the
//! message, decoded by `src/shared/motifs/errors.ts` at the process boundary.
//! napi async exports carry no custom `error.code`, hence the tag.
//!
//! LANDMINE: `anyhow::Error::to_string()` prints only the outermost context and
//! drops a tag below it. Every Motif error that leaves Rust goes through
//! `to_napi` or `format!("{e:#}")`, worker replies included.

/// The native subset of `MotifErrorCode`; the wire names are the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MotifCode {
    /// The stored frame is absent or invalid.
    Miss,
    /// A file or keyed mutex is briefly held; retrying may succeed.
    #[cfg_attr(not(windows), allow(dead_code))]
    Transient,
    /// The frame or pool exceeds a fixed budget.
    #[cfg_attr(not(windows), allow(dead_code))]
    Oversize,
    /// The D3D11 device or a native worker failed.
    #[cfg_attr(not(windows), allow(dead_code))]
    Device,
    /// The pool or reader was closed.
    #[cfg_attr(not(windows), allow(dead_code))]
    Closed,
}

impl MotifCode {
    fn wire(self) -> &'static str {
        match self {
            Self::Miss => "miss",
            Self::Transient => "transient",
            Self::Oversize => "oversize",
            Self::Device => "device",
            Self::Closed => "closed",
        }
    }
}

/// The inner error is printed in its alternate form inside the tag, so the
/// chain ends here and nothing is printed twice.
#[derive(Debug)]
struct Coded {
    code: MotifCode,
    error: anyhow::Error,
}

impl std::fmt::Display for Coded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[motif:{}] {:#}", self.code.wire(), self.error)
    }
}

impl std::error::Error for Coded {}

pub(crate) fn coded(code: MotifCode, error: impl Into<anyhow::Error>) -> anyhow::Error {
    anyhow::Error::new(Coded {
        code,
        error: error.into(),
    })
}

/// The code anywhere in `error`'s chain.
#[cfg(test)]
pub(crate) fn code_of(error: &anyhow::Error) -> Option<MotifCode> {
    error
        .chain()
        .find_map(|e| e.downcast_ref::<Coded>())
        .map(|c| c.code)
}

/// The whole chain, so a tag below any context survives.
#[cfg_attr(test, allow(dead_code))] // napi exports are absent in a Rust unit-test executable.
pub(crate) fn to_napi(error: anyhow::Error) -> napi::Error {
    napi::Error::from_reason(format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use super::{code_of, coded, MotifCode};

    #[test]
    fn the_tag_is_the_wire_literal() {
        // LANDMINE: the same literal is pinned in `src/shared/motifs/errors.test.ts`.
        assert_eq!(
            format!("{:#}", coded(MotifCode::Miss, anyhow::anyhow!("x"))),
            "[motif:miss] x"
        );
    }

    #[test]
    fn the_code_survives_context_and_the_alternate_form_keeps_the_tag() {
        let error = coded(MotifCode::Device, anyhow::anyhow!("lost")).context("upload");
        assert_eq!(code_of(&error), Some(MotifCode::Device));
        assert_eq!(format!("{error:#}"), "upload: [motif:device] lost");
        assert_eq!(error.to_string(), "upload");
        assert_eq!(code_of(&anyhow::anyhow!("plain")), None);
    }

    #[test]
    fn every_code_has_its_wire_name() {
        for (code, wire) in [
            (MotifCode::Miss, "miss"),
            (MotifCode::Transient, "transient"),
            (MotifCode::Oversize, "oversize"),
            (MotifCode::Device, "device"),
            (MotifCode::Closed, "closed"),
        ] {
            assert_eq!(code.wire(), wire);
        }
    }
}

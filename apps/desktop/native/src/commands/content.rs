//! App-managed content helpers (ADR 0039 / 0043 / 0073). One stateless compute
//! command: extract a downloaded tar archive into a staging directory. The
//! caller (the TypeScript downloader in Electron main, which owns the whole
//! download → verify → install lifecycle) has already SHA-256-verified the
//! archive; this is purely the decompression half, in Rust because native
//! bzip2 is an order of magnitude faster than a JS decoder on a 234 MB model
//! archive.

use std::fs::File;
use std::io::{BufReader, Cursor, Read};
use std::path::Path;

/// Leading bytes that tell the two compressions apart. The caller pins a
/// `sha256` per artifact, so the bytes here are always exactly the artifact the
/// catalog named: sniffing decides which decoder to build, it does not decide
/// whether to trust the payload.
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];
const BZIP2_MAGIC: [u8; 3] = *b"BZh";

/// Unpack `archive_path` (a bzip2- or gzip-compressed tar) into `dest_dir`,
/// creating it first. Returns the number of file entries written.
///
/// Path-traversal safety is the `tar` crate's `unpack` containment: an entry
/// whose path would land outside `dest_dir` (absolute, or `..`-traversing)
/// makes the whole unpack fail rather than write outside — pinned by the
/// traversal test below, mirroring the TypeScript zip-slip guard on the zip
/// lane.
///
/// `unpack_in` is also what makes the Linux runtimes usable: it applies each
/// entry's mode (the executable bit) and recreates symlinks, both of which the
/// whisper.cpp / llama.cpp Linux tarballs depend on — their binaries resolve
/// `libwhisper.so.1` and friends through `$ORIGIN` links.
pub async fn extract_tar(archive_path: String, dest_dir: String) -> Result<u32, String> {
    // Decompression is CPU-bound for seconds — keep it off the async runtime.
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dest_dir).map_err(|e| format!("create {dest_dir}: {e}"))?;
        let file = File::open(&archive_path).map_err(|e| format!("open {archive_path}: {e}"))?;
        let mut reader = BufReader::new(file);
        let mut magic = [0u8; 3];
        reader
            .read_exact(&mut magic)
            .map_err(|e| format!("read {archive_path}: {e}"))?;
        // The sniffed bytes are part of the stream both decoders expect, so
        // they go back in front of it rather than being seeked over.
        let stream = Cursor::new(magic).chain(reader);
        let decoder: Box<dyn Read> = if magic[..2] == GZIP_MAGIC {
            Box::new(flate2::read::GzDecoder::new(stream))
        } else if magic == BZIP2_MAGIC {
            Box::new(bzip2::read::BzDecoder::new(stream))
        } else {
            return Err(format!("unrecognized archive compression: {archive_path}"));
        };
        let mut archive = tar::Archive::new(decoder);
        let mut written: u32 = 0;
        for entry in archive
            .entries()
            .map_err(|e| format!("read archive: {e}"))?
        {
            let mut entry = entry.map_err(|e| format!("read entry: {e}"))?;
            let path = entry
                .path()
                .map_err(|e| format!("entry path: {e}"))?
                .into_owned();
            // `unpack_in` returns Ok(false) for entries it refuses to place
            // inside `dest_dir` (traversal / absolute paths). Refusal is a
            // hostile archive, and the sha already matched — fail the whole
            // extraction loudly instead of installing a partial payload.
            let unpacked = entry
                .unpack_in(Path::new(&dest_dir))
                .map_err(|e| format!("unpack {}: {e}", path.display()))?;
            if !unpacked {
                return Err(format!(
                    "archive entry escapes the destination: {}",
                    path.display()
                ));
            }
            if entry.header().entry_type().is_file() {
                written += 1;
            }
        }
        Ok(written)
    })
    .await
    .map_err(|e| format!("extraction task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a .tar.bz2 on disk from (path, contents) pairs.
    fn write_archive(dir: &Path, entries: &[(&str, &[u8])]) -> String {
        let archive_path = dir.join("fixture.tar.bz2");
        let file = File::create(&archive_path).unwrap();
        let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
        archive_path.to_string_lossy().into_owned()
    }

    /// The .tar.gz twin — the shape the Linux whisper.cpp and llama.cpp builds
    /// ship, down to the executable mode and the sibling symlink their runtime
    /// resolves through `$ORIGIN`.
    fn write_gz_runtime_archive(dir: &Path) -> String {
        let archive_path = dir.join("fixture.tar.gz");
        let file = File::create(&archive_path).unwrap();
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (path, data, mode) in [
            ("runtime/cli", b"elf-bytes".as_slice(), 0o755),
            ("runtime/libx.so.1.2.3", b"so-bytes".as_slice(), 0o644),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(mode);
            header.set_cksum();
            builder.append_data(&mut header, path, data).unwrap();
        }
        let mut link = tar::Header::new_gnu();
        link.set_size(0);
        link.set_mode(0o777);
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_cksum();
        builder
            .append_link(&mut link, "runtime/libx.so.1", "libx.so.1.2.3")
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        archive_path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn roundtrips_nested_entries_and_counts_files() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = write_archive(
            tmp.path(),
            &[
                ("bundle/bin/tool.exe", b"exe-bytes".as_slice()),
                ("bundle/tokens.txt", b"a b c".as_slice()),
            ],
        );
        let dest = tmp.path().join("out");
        let n = extract_tar(archive, dest.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            std::fs::read(dest.join("bundle/bin/tool.exe")).unwrap(),
            b"exe-bytes"
        );
        assert_eq!(
            std::fs::read(dest.join("bundle/tokens.txt")).unwrap(),
            b"a b c"
        );
    }

    #[tokio::test]
    async fn a_traversal_entry_fails_the_whole_extraction() {
        let tmp = tempfile::tempdir().unwrap();
        // tar::Builder::append_data refuses ".." paths itself, so craft the
        // header manually the way a hostile archive would carry it.
        let archive_path = tmp.path().join("evil.tar.bz2");
        let file = File::create(&archive_path).unwrap();
        let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let data = b"pwn";
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        {
            // Write the raw path bytes into the header, bypassing set_path's
            // validation.
            let name = b"../escape.txt";
            header.as_old_mut().name[..name.len()].copy_from_slice(name);
        }
        header.set_cksum();
        builder.append(&header, data.as_slice()).unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let dest = tmp.path().join("out");
        let result = extract_tar(
            archive_path.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .await;
        assert!(result.is_err(), "traversal entry must fail extraction");
        assert!(!tmp.path().join("escape.txt").exists());
    }

    /// The Linux artifacts (ADR 0073) are gzip, and nothing in the catalog
    /// tells the extractor which it is holding — the magic bytes do.
    #[tokio::test]
    async fn a_gzip_tar_extracts_through_the_same_command() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = write_gz_runtime_archive(tmp.path());
        let dest = tmp.path().join("out");
        let n = extract_tar(archive, dest.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            std::fs::read(dest.join("runtime/cli")).unwrap(),
            b"elf-bytes"
        );
    }

    /// A runtime whose executable bit or `$ORIGIN` symlink was flattened on the
    /// way in installs clean and then refuses to start, so both are pinned.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_extracted_runtime_keeps_its_exec_bit_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let archive = write_gz_runtime_archive(tmp.path());
        let dest = tmp.path().join("out");
        extract_tar(archive, dest.to_string_lossy().into_owned())
            .await
            .unwrap();
        let mode = std::fs::metadata(dest.join("runtime/cli"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "the entry's executable bit survives");
        let link = dest.join("runtime/libx.so.1");
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(std::fs::read(&link).unwrap(), b"so-bytes");
    }

    #[tokio::test]
    async fn a_corrupt_archive_reports_an_error_not_a_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.tar.bz2");
        File::create(&bad)
            .unwrap()
            .write_all(b"this is not bzip2 data")
            .unwrap();
        let dest = tmp.path().join("out");
        let result = extract_tar(
            bad.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .await;
        assert!(result.is_err());
    }
}

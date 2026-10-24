fn main() {
    napi_build::setup();

    #[cfg(target_os = "linux")]
    {
        println!("cargo:rerun-if-changed=src/glibc_compat.c");
        cc::Build::new()
            .file("src/glibc_compat.c")
            .compile("glibc_compat");
    }
}


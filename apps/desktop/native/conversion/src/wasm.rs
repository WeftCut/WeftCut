//! One batch request/response per conversion. Buffers belong to the instance;
//! terminating the worker cancels Rust execution and releases its linear memory.
use std::cell::RefCell;
thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}
#[no_mangle]
pub extern "C" fn conversion_input(len: usize) -> *mut u8 {
    INPUT.with(|b| {
        let mut b = b.borrow_mut();
        b.resize(len, 0);
        b.as_mut_ptr()
    })
}
#[no_mangle]
pub extern "C" fn conversion_run() -> usize {
    let result = INPUT.with(|b| {
        serde_json::from_slice::<crate::Request>(&b.borrow())
            .map_err(|_| "conversion_options_error")
            .and_then(crate::convert)
    });
    let response = match result {
        Ok(result) => serde_json::json!({"ok":true,"result":result}),
        Err(code) => serde_json::json!({"ok":false,"code":code}),
    };
    OUTPUT.with(|b| {
        let mut b = b.borrow_mut();
        *b = serde_json::to_vec(&response).expect("finite conversion response");
        b.len()
    })
}
#[no_mangle]
pub extern "C" fn conversion_output() -> *const u8 {
    OUTPUT.with(|b| b.borrow().as_ptr())
}

// What the specs reach on the app's globals: the renderer's `window` inside
// `page.evaluate`, and Electron's main-process modules inside `app.evaluate`.
import type { WeftcutApi } from '../../src/shared/ipc'
import type { E2EHook } from '../../src/renderer/testhook/e2eHook'

// Outside the namespace below, where `Parameters` would name Electron's own type.
type InvokeHandler = Parameters<Electron.IpcMain['handle']>[1]

declare global {
  interface Window {
    /** The preload bridge, as src/renderer/bridge/ipc.ts declares it. */
    api: WeftcutApi
    /** The test hook. Its members install as the panels that own them mount,
     *  so a spec waits for one (`waitForHook`) before calling it. */
    __weftcutTest: E2EHook
  }

  namespace Electron {
    interface IpcMain {
      /** LANDMINE — Electron internal, absent from its typings: the map
       *  `ipcMain.handle` registers into, which specs rewrite to intercept a
       *  channel. A rename in an Electron upgrade fails those specs at run
       *  time, not here. */
      _invokeHandlers: Map<string, InvokeHandler>
    }
  }
}

// apps/desktop/src/main/quitSave.ts
//
// The quit's final save and the question asked when it fails with edits unsaved
// (docs/data-model.md § Saving). Owns the decision loop and the dialog's wording;
// index.ts owns the Electron side (when it runs, the dialog call, app.quit).

export type QuitSaveChoice = 'retry' | 'discard' | 'cancel'

/** Button order of the dialog; the response index maps through it. Retry is the
 *  default, Cancel what Escape answers. */
export const QUIT_SAVE_CHOICES: readonly QuitSaveChoice[] = ['retry', 'discard', 'cancel']

export interface QuitSaveDeps {
  /** Flushes and closes the project (`TsActorHost.shutdown`). On failure it
   *  rejects with the project still open. */
  save: () => Promise<void>
  /** Whether edits would be lost by quitting now. */
  unsaved: () => boolean
  ask: (error: unknown) => Promise<QuitSaveChoice>
  /** Quit without saving: the project closes with nothing more written. */
  discard: () => void
}

/** True to go on quitting, false to stay (Cancel). A failure with nothing
 *  unsaved quits without asking: no edit is lost by it. */
export async function settleQuitSave(deps: QuitSaveDeps): Promise<boolean> {
  for (;;) {
    try {
      await deps.save()
      return true
    } catch (error) {
      if (!deps.unsaved()) {
        console.warn('[main] quit-flush failed with nothing unsaved', error)
        return true
      }
      const choice = await deps.ask(error)
      if (choice === 'cancel') return false
      if (choice === 'discard') { deps.discard(); return true }
    }
  }
}

/** The dialog for `settleQuitSave`'s question, in the two languages main's
 *  native dialogs speak. The reason is the system's own message: main has no
 *  translated copy of the renderer's plain-language reasons. */
export function quitSaveDialog(zh: boolean, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    type: 'warning' as const,
    noLink: true,
    message: zh ? '项目无法保存' : 'The project could not be saved',
    detail: zh
      ? `退出将丢失上次保存之后的编辑。\n\n原因：${reason}`
      : `Quitting now loses the edits made since the last save.\n\nReason: ${reason}`,
    buttons: zh ? ['重试', '不保存并退出', '取消'] : ['Retry', 'Quit Without Saving', 'Cancel'],
    defaultId: QUIT_SAVE_CHOICES.indexOf('retry'),
    cancelId: QUIT_SAVE_CHOICES.indexOf('cancel'),
  }
}

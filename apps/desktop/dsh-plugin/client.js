// The browser half: a right-sidebar page tab that frames WeftCut's side
// preview, the row for the `open_side_preview` tool call, which opens it, and
// the tab's connect panel, which runs `/weftcut` (index.js) when no link is
// known yet. The page itself is served by the app (docs/mcp.md § Companion
// page); WeftCut writes this plugin (main/mcp/dshPluginInstall.ts).
window.__ModuleLoader__.load({
  id: '@weftcut/dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ID = '@weftcut/dsh'
    const KIND = 'weftcut-side-preview'
    const NS = 'weftcut'
    // dsh names an MCP tool `mcp__<serverName>__<tool>`; `weftcut` is the
    // serverName of this plugin's server row.
    const TOOL = 'mcp__weftcut__open_side_preview'
    const COMMAND = 'weftcut'
    // The only link the app hands out (main/index.ts, companion link). Anything
    // else in a result is not framed.
    const LINK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/companion#k=[0-9a-f]{64}$/
    // The same link inside `/weftcut`'s result line.
    const LINK_IN_TEXT = new RegExp(LINK.source.slice(1, -1))
    // A tab's navigation params are not kept across a reload, so the last link
    // is, in this origin's storage, as dsh's own Browser keeps its URLs.
    const LAST_LINK = 'weftcut.sidePreview.lastLink'
    // A result older than this is history being replayed (a reload, a resumed
    // Session): it gets the button, never an automatic open.
    const FRESH_MS = 60_000

    // No `allow-same-origin` needed: the page works in an opaque-origin frame
    // (docs/mcp.md § Sandboxed frames), so it gets none.
    const SANDBOX = 'allow-scripts'
    // Copy as image and picture-in-picture, which the page offers.
    const ALLOW = 'clipboard-write; picture-in-picture'

    const en = {
      tab: 'WeftCut',
      guideTitle: 'WeftCut side preview',
      guideDescription: 'Timeline, player and live picture of the edit',
      connectTitle: 'WeftCut side preview',
      connectHint: 'The timeline, player and live picture of the edit, beside the chat. Starts WeftCut if it is closed.',
      connectButton: 'Open WeftCut',
      connecting: 'Opening…',
      row: 'Side preview',
      open: 'Open',
      frame: 'WeftCut side preview',
    }
    const zh = {
      tab: 'WeftCut',
      guideTitle: 'WeftCut 侧边预览',
      guideDescription: '剪辑的时间线、播放控制和实时画面',
      connectTitle: 'WeftCut 侧边预览',
      connectHint: '在对话旁边显示剪辑的时间线、播放控制和实时画面。WeftCut 没开时会先启动它。',
      connectButton: '打开 WeftCut',
      connecting: '正在打开…',
      row: '侧边预览',
      open: '打开',
      frame: 'WeftCut 侧边预览',
    }

    /** The link in a successful result, or undefined. WeftCut answers
     *  `{"url": …}` as the result's text, the only part that reaches the page. */
    function linkOf(block) {
      if (block == null || block.isError) return undefined
      for (const part of block.content ?? []) {
        if (part.type !== 'text') continue
        try {
          const url = JSON.parse(part.text).url
          if (typeof url === 'string' && LINK.test(url)) return url
        } catch {}
      }
      return undefined
    }

    function readLast() {
      try {
        const url = localStorage.getItem(LAST_LINK)
        return url !== null && LINK.test(url) ? url : undefined
      } catch { return undefined }
    }

    function keepLast(url) {
      try { localStorage.setItem(LAST_LINK, url) } catch {}
    }

    // The frame exists only while the tab is in view. dsh keeps a body mounted
    // in a collapsed sidebar, and a hidden frame's page still counts as open
    // (document.hidden follows the Harness window), so the app would keep
    // feeding it state and, if asked for, the picture.
    function Body({ useTabInfo, useSidebarMounted, connect, t }) {
      const { tab } = useTabInfo()
      const sessionId = useSidebarMounted((session) => session)
      if (!tab.visible) return null
      const param = tab.navigation.params?.url
      const url = typeof param === 'string' && LINK.test(param) ? param : readLast()
      if (url === undefined) return h(Connect, { t, sessionId, connect })
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
      }, h('iframe', {
        key: url,
        src: url,
        title: t('frame'),
        sandbox: SANDBOX,
        allow: ALLOW,
        referrerPolicy: 'no-referrer',
        style: { flex: '1 1 auto', width: '100%', minHeight: 0, border: 0, display: 'block' },
      }))
    }

    /** No link known yet: one button that runs `/weftcut` on this Session. */
    function Connect({ t, sessionId, connect }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const run = async () => {
        setBusy(true)
        setError(null)
        const failure = await connect(sessionId)
        setBusy(false)
        setError(failure)
      }
      return h('div', { style: CONNECT },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, h(Glyph, { size: 40 })),
        h('div', { style: { fontSize: 16, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' } }, t('connectTitle')),
        h('div', { style: { fontSize: 13, lineHeight: '20px', maxWidth: 320, color: 'var(--dsw-alias-label-secondary)' } }, t('connectHint')),
        h('button', {
          type: 'button',
          disabled: busy || sessionId === undefined,
          onClick: () => { void run() },
          style: { ...PRIMARY_BUTTON, opacity: busy || sessionId === undefined ? 0.4 : 1, cursor: busy ? 'default' : 'pointer' },
        }, busy ? t('connecting') : t('connectButton')),
        error !== null
          ? h('div', { style: { fontSize: 13, lineHeight: '20px', maxWidth: 360, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, error)
          : null)
    }

    // The callIds this page has opened a tab for, so a re-rendered row does
    // not open it again.
    const opened = new Set()

    function Row({ phase, block, callId, sessionId, openPreview, useSidebarMounted, t }) {
      const url = phase === 'result' ? linkOf(block) : undefined
      const onScreen = useSidebarMounted((session) => session === sessionId)
      React.useEffect(() => {
        if (url === undefined || !onScreen || opened.has(callId)) return
        opened.add(callId)
        if (Date.now() - block.time > FRESH_MS) return
        openPreview(url)
      }, [url, onScreen, callId])
      const failed = phase === 'result' && url === undefined
      const reason = failed
        ? (block.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        : ''
      return h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
        h('div', { style: ROW },
          h('span', { style: LEADING }, h(Glyph)),
          h('span', { style: TEXT }, t('row')),
          h('button', {
            type: 'button',
            disabled: url === undefined,
            onClick: () => { if (url !== undefined) openPreview(url) },
            style: url === undefined
              ? { ...TEXT, ...LINK_BUTTON, color: 'inherit', textDecoration: 'none', cursor: 'default' }
              : { ...TEXT, ...LINK_BUTTON, cursor: 'pointer' },
          }, t('open'))),
        failed && reason !== ''
          ? h('div', { style: { ...TEXT, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingLeft: 22 } }, reason)
          : null)
    }

    // Geometry and tokens of dsh's own tool rows (ui-tool ToolRow), so this
    // row sits in the call list like its neighbours.
    const ROW = {
      display: 'flex', alignItems: 'center', gap: 4, minWidth: 0,
      height: 'calc(24px + var(--dsh-content-font-delta, 0px))',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    const LEADING = {
      flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 2,
      width: 'calc(16px + var(--dsh-content-font-delta, 0px))',
      height: 'calc(16px + var(--dsh-content-font-delta, 0px))',
    }
    const TEXT = {
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
    }
    const CONNECT = {
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
      height: '100%', minHeight: 0, padding: 24, boxSizing: 'border-box', textAlign: 'center',
    }
    // dsh's own primary button (ui-primitives Button, size md).
    const PRIMARY_BUTTON = {
      height: 36, padding: '0 20px', border: 'none', borderRadius: 'var(--dsw-radius-md)',
      fontFamily: 'inherit', fontSize: 14, lineHeight: '22px',
      background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
    }
    const LINK_BUTTON = {
      fontFamily: 'inherit', border: 0, padding: '0 4px', margin: 0, background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)', textDecoration: 'underline', textUnderlineOffset: 2,
    }

    // A frame with a play mark, in the surrounding text colour.
    function GuideIcon() {
      return h(Glyph, { size: 20 })
    }

    function Glyph({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M6.5 5.6v4.8L10.6 8z', fill: 'currentColor' }))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'weftcut: dictionaries')
        const t = ctx.locale.bind(NS)

        const openPreview = (url) => {
          keepLast(url)
          // Throws with no Session on screen; the row's button is pressed on
          // one, and the automatic open waits for its own Session.
          try { ctx.sidebarRight.openTab(KIND, { params: { url } }) } catch (error) {
            console.warn('[weftcut] could not open the tab', error)
          }
        }
        const linkInLine = (text) => LINK_IN_TEXT.exec(text ?? '')?.[0]

        // The connect panel's button: the same `/weftcut` a user can type.
        // Resolves to the failure to show, or null.
        const connect = async (sessionId) => {
          try {
            const result = await ctx.remote.commands.execute(sessionId, `/${COMMAND}`, [])
            if (!result.ok) return `${result.error.message} (${result.error.code})`
            if (result.value === undefined) return `/${COMMAND} is not available.`
            const outcome = result.value.result
            const url = outcome.kind === 'success' ? linkInLine(outcome.text) : undefined
            if (url === undefined) return outcome.text ?? `/${COMMAND} did not return a link.`
            openPreview(url)
            return null
          } catch (error) {
            return String(error?.message ?? error)
          }
        }

        // A typed `/weftcut` opens the tab too. Only this browser hears it:
        // ui-commands emits it after its own submission settles.
        ctx.on('command/executed', (_sessionId, name, result) => {
          if (name !== COMMAND || result?.kind !== 'success') return
          const url = linkInLine(result.text)
          if (url !== undefined) openPreview(url)
        })

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          title: () => t('tab'),
          guide: [{ id: 'open', order: 40, title: () => t('guideTitle'), description: () => t('guideDescription'), icon: GuideIcon }],
        }), 'weftcut: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: ID, locale: NS,
          inject: () => ({ connect, hooks: { sidebarMounted: ctx.sidebarRight.mounted } }),
        }, Body))

        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: TOOL,
          locale: NS,
          inject: (sessionId) => ({ sessionId, openPreview, hooks: { sidebarMounted: ctx.sidebarRight.mounted } }),
        }, Row))
      },
    }
  },
})

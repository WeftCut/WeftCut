// The companion page's copy. The page speaks the app's UI language (sent with
// the state), not the browser's; before the first state arrives it has only
// the browser's to go on. Both tables carry the same keys.

export const STRINGS = {
  en: {
    lang: 'en',
    title: 'WeftCut',
    show_editor: 'Show WeftCut',
    play: 'Play',
    pause: 'Pause',
    timeline: 'Timeline',
    timeline_empty: 'The timeline is empty.',
    exporting: 'Exporting {percent}% · {file}',
    activity_running: '{client} is running {tool}',
    activity_done: '{client} ran {tool}',
    activity_error: '{client}: {tool} failed',
    state_revoked: 'This link no longer works. Ask the agent for a new one.',
    state_offline: 'WeftCut is not running. This page reconnects when it opens.',
    state_opening: 'WeftCut is opening the project…',
    state_no_project: 'No project is open in WeftCut.',
    show_picture: 'Show picture',
    hide_picture: 'Hide picture',
    picture_off: "The picture is off. Turning it on uses some of WeftCut's processing.",
    picture_starting: 'Starting the picture…',
    picture_export: 'Exporting: no picture until the export ends.',
    picture_minimized: 'WeftCut is minimized, so the picture updates about once a second.',
    picture_unsupported: 'This browser cannot show the picture.',
  },
  zh: {
    lang: 'zh',
    title: 'WeftCut',
    show_editor: '切到 WeftCut',
    play: '播放',
    pause: '暂停',
    timeline: '时间线',
    timeline_empty: '时间线为空。',
    exporting: '正在导出 {percent}% · {file}',
    activity_running: '{client} 正在执行 {tool}',
    activity_done: '{client} 已执行 {tool}',
    activity_error: '{client}：{tool} 失败',
    state_revoked: '此链接已失效，请让 agent 重新获取。',
    state_offline: 'WeftCut 未在运行。它启动后此页面会自动重新连接。',
    state_opening: 'WeftCut 正在打开项目…',
    state_no_project: 'WeftCut 中没有打开的项目。',
    show_picture: '显示画面',
    hide_picture: '隐藏画面',
    picture_off: '画面已关闭。开启后会占用 WeftCut 的一部分处理能力。',
    picture_starting: '正在开启画面…',
    picture_export: '正在导出：导出结束前不显示画面。',
    picture_minimized: 'WeftCut 已最小化，画面约每秒更新一次。',
    picture_unsupported: '此浏览器无法显示画面。',
  },
}

/** The table for a locale code such as `zh-CN`; English for anything else. */
export function stringsFor(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
}

/** `text` with each `{name}` replaced by `values[name]`. */
export function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''))
}

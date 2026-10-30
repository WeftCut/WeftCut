export function formatFileBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toLocaleString('ru-RU', { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

export function installExportFiles({ document, fetch, EventSource, storage }) {
  const dialog = document.getElementById('export-files-dialog');
  const list = document.getElementById('export-files-list');
  const message = document.getElementById('export-files-message');
  let events = null, lastEvent = null;
  try { lastEvent = storage.getItem('weftcut-file-reveal'); } catch {}
  function show(files, selected) {
    list.replaceChildren();
    message.textContent = files.length ? 'Готовые файлы можно скачать на ваш компьютер.' : 'После экспорта нажмите «Показать в папке» в редакторе — файл появится здесь.';
    for (const file of files) {
      if (!/^\/api\/files\/[A-Za-z0-9_-]+\/download$/.test(file.download_url)) continue;
      const row = document.createElement('article'); row.className = 'export-file';
      if (file.id === selected) row.classList.add('selected');
      const details = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = file.name;
      const meta = document.createElement('p'); meta.textContent = formatFileBytes(file.bytes);
      const folder = document.createElement('small'); folder.textContent = file.folder;
      const link = document.createElement('a'); link.href = file.download_url; link.download = file.name;
      link.className = 'download-file'; link.textContent = 'Скачать'; link.setAttribute('aria-label', 'Скачать ' + file.name);
      details.append(title, meta, folder); row.append(details, link); list.append(row);
    }
    if (!dialog.open) dialog.showModal();
  }
  async function open(selected) {
    try {
      const response = await fetch('/api/files', { cache: 'no-store' });
      if (!response.ok) throw Error('File list unavailable');
      show((await response.json()).files, selected);
    } catch {
      message.textContent = 'Не удалось получить файлы. Проверьте подключение и попробуйте ещё раз.';
      list.replaceChildren(); if (!dialog.open) dialog.showModal();
    }
  }
  document.getElementById('export-files').onclick = () => { void open(); };
  document.getElementById('export-files-close').onclick = () => dialog.close();
  const connect = () => {
    if (events) return;
    events = new EventSource('/api/files/events');
    events.addEventListener('reveal', event => {
      try {
        const data = JSON.parse(event.data);
        if (!data.event_id || data.event_id === lastEvent) return;
        lastEvent = data.event_id;
        try { storage.setItem('weftcut-file-reveal', lastEvent); } catch {}
        void open(data.file.id);
      } catch { /* malformed event must not interrupt preview */ }
    });
  };
  const close = () => { events?.close(); events = null; };
  connect();
  return { open, connect, close };
}

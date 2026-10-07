/* Files stay in the local loan database; only readable ticket text is extracted. */
const LoanAttachments = (() => {
  const maxFileSize = 10 * 1024 * 1024;
  const maxTotalSize = 25 * 1024 * 1024;
  function readDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }
  function decodeBody(body, encoding, charset) {
    let bytes;
    if (/base64/i.test(encoding)) {
      bytes = Uint8Array.from(atob(body.replace(/\s/g, '')), char => char.charCodeAt(0));
    } else if (/quoted-printable/i.test(encoding)) {
      const raw = body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
    } else return body;
    try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
    catch { return new TextDecoder('utf-8').decode(bytes); }
  }
  function htmlText(html) {
    // Do not load remote email images or other embedded resources during extraction.
    const inertHTML = html.replace(/<(?:img|iframe|link|object|embed|source|audio|video)\b[^>]*>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/\s(?:src|srcset|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    const doc = new DOMParser().parseFromString(inertHTML, 'text/html');
    doc.querySelectorAll('script, style, iframe, object').forEach(node => node.remove());
    doc.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    doc.querySelectorAll('p, div, tr, li').forEach(node => node.append('\n'));
    return doc.body.textContent.trim();
  }
  function emailText(raw) {
    const split = raw.search(/\r?\n\r?\n/);
    if (split === -1) return raw;
    const headers = raw.slice(0, split).replace(/\r?\n[ \t]+/g, ' ');
    const body = raw.slice(split).replace(/^\r?\n\r?\n/, '');
    const contentType = headers.match(/^content-type:\s*(.+)$/im)?.[1] || 'text/plain';
    const boundary = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    if (/multipart\//i.test(contentType) && boundary) {
      const parts = body.split('--' + (boundary[1] || boundary[2])).slice(1).filter(part => !part.startsWith('--'));
      const plain = parts.filter(part => /content-type:\s*text\/plain/i.test(part) && !/content-disposition:\s*attachment/i.test(part));
      const selected = plain.length ? plain : parts.filter(part => !/content-disposition:\s*attachment/i.test(part));
      return selected.map(part => emailText(part.replace(/^\r?\n/, ''))).filter(Boolean).join('\n');
    }
    if (!/^text\/(plain|html)/i.test(contentType) || /content-disposition:\s*attachment/i.test(headers)) return '';
    const encoding = headers.match(/^content-transfer-encoding:\s*(.+)$/im)?.[1] || '';
    const charset = contentType.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1];
    const decoded = decodeBody(body, encoding, charset);
    return /^text\/html/i.test(contentType) ? htmlText(decoded) : decoded.trim();
  }
  async function prepare(file) {
    if (file.size > maxFileSize) throw new Error(`${file.name}: maximum file size is 10 MB.`);
    const dataURL = await readDataURL(file);
    let text = '';
    const extension = file.name.split('.').pop().toLowerCase();
    if (['eml', 'txt', 'csv', 'tsv', 'html', 'htm', 'json', 'xml'].includes(extension) || file.type.startsWith('text/')) {
      const raw = await file.text();
      text = extension === 'eml' ? emailText(raw) : ['html', 'htm'].includes(extension) ? htmlText(raw) : raw;
    }
    return { attachment: {
      id: crypto.randomUUID(), name: file.name, size: file.size,
      type: file.type || 'application/octet-stream', lastModified: file.lastModified,
      data: dataURL.split(',')[1]
    }, text };
  }
  function download(attachment) {
    const bytes = Uint8Array.from(atob(attachment.data), char => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { prepare, download, emailText, maxTotalSize };
})();

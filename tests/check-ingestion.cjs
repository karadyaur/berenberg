const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base64 = value => Buffer.from(value, 'utf8').toString('base64');
class Reader {
  readAsDataURL(file) {
    this.result = `data:${file.type};base64,${Buffer.from(file.bytes).toString('base64')}`;
    queueMicrotask(() => this.onload());
  }
}
const context = vm.createContext({
  FileReader: Reader, Uint8Array, TextDecoder, crypto: require('node:crypto').webcrypto,
  atob: value => Buffer.from(value, 'base64').toString('binary')
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/attachments.js'), 'utf8'), context);
const attachments = vm.runInContext('LoanAttachments', context);
const ticket = 'ID:777 | ISIN:GB0002634946 | Shares:12 | Stock Name:Security |';
(async () => {
  assert.equal(attachments.emailText(`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(ticket)}`), ticket);
  assert.equal(attachments.emailText('Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nStock Name: =C3=89nergie=\n | Shares:12'), 'Stock Name: Énergie | Shares:12');
  const email = `Content-Type: multipart/mixed; boundary="mail"\r\n\r\n--mail\r\nContent-Type: text/plain\r\n\r\n${ticket}\r\n--mail\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=extra.txt\r\n\r\nDO NOT PARSE\r\n--mail--`;
  assert.equal(attachments.emailText(email), ticket, 'email attachments cannot become ticket text');
  const bytes = Buffer.from([0, 255, 18, 32, 0, 67]);
  const binary = await attachments.prepare({ name: 'original.msg', size: bytes.length, type: '', lastModified: 1, bytes });
  assert.deepEqual(Buffer.from(binary.attachment.data, 'base64'), bytes, 'binary attachments must round-trip unchanged');
  assert.equal(binary.text, '');
  const eml = await attachments.prepare({ name: 'ticket.eml', size: email.length, type: 'message/rfc822', lastModified: 2, bytes: Buffer.from(email), text: async () => email });
  assert.equal(eml.text, ticket);
  await assert.rejects(attachments.prepare({ name: 'large.pdf', size: 11 * 1024 * 1024 }), /10 MB/);

  console.log('PASS: MIME emails, binary file integrity and file limits.');
})().catch(error => { console.error(error); process.exitCode = 1; });

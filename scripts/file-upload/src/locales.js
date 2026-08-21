// dsh-desktop-file-upload — composer button dictionaries (zh / en).

const NS = 'file-upload'

const zh = {
  title: '上传文件',
  readFailed: '读取文件失败',
  uploadFailed: '上传文件失败',
  tooLarge: '文件过大（上限 #{limit}）',
  remove: '移除文件',
  open: '打开文件',
  openFailed: '打开文件失败',
}

const en = {
  title: 'Upload file',
  readFailed: 'Failed to read file',
  uploadFailed: 'Failed to upload file',
  tooLarge: 'File too large (limit #{limit})',
  remove: 'Remove file',
  open: 'Open file',
  openFailed: 'Failed to open file',
}

module.exports = { NS, zh, en }

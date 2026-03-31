const ENABLE_COLOR = process.env.EXTERNAL_COLOR === '1'

const colors = {
  runner: '\u001b[36m',
  scheduler: '\u001b[33m',
  server: '\u001b[90m',
  bot: '\u001b[35m',
  trace: '\u001b[32m'
}

function colorize (kind, text) {
  if (!ENABLE_COLOR) return text
  const reset = '\u001b[0m'
  const color = colors[kind] ?? ''
  return color ? `${color}${text}${reset}` : text
}

function logExternal (kind, text) {
  console.log(colorize(kind, text))
}

function formatValue (value) {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

module.exports = {
  colorize,
  formatValue,
  logExternal
}

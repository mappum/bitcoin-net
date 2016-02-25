var url = require('url')

function getRandom (array) {
  return array[Math.floor(Math.random() * array.length)]
}

function parseAddress (address) {
  var parsed = url.parse(address)
  if (parsed.protocol && parsed.hostname && parsed.port) {
    return parsed
  }
  return url.parse('x://' + address)
}

module.exports = { getRandom, parseAddress }
